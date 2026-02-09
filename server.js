const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============= ENV VARS =============
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // required
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID; // required (single channel)
const WEBENGAGE_LICENSE_CODE = process.env.WEBENGAGE_LICENSE_CODE; // required
const WEBENGAGE_API_KEY = process.env.WEBENGAGE_API_KEY; // required (Bearer token value only)
const STORE_API_KEY = process.env.STORE_API_KEY; // required (x-api-key)
const FIRE_JOIN_EVENT = (process.env.FIRE_JOIN_EVENT || "true").toLowerCase() === "true"; // safety toggle

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !WEBENGAGE_LICENSE_CODE || !WEBENGAGE_API_KEY || !STORE_API_KEY) {
  console.error("Missing required env vars. Check TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, WEBENGAGE_LICENSE_CODE, WEBENGAGE_API_KEY, STORE_API_KEY");
}

const db = new Firestore();

// Collections
const COL_TXN = "txn_invites";        // docId = transactionId
const COL_INV = "invite_lookup";      // docId = hash(inviteLink)

// Helpers
function nowIso() { return new Date().toISOString(); }

function hashInviteLink(inviteLink) {
  return crypto.createHash("sha256").update(String(inviteLink || "")).digest("hex");
}

async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  const payload = {
    chat_id: channelId,
    member_limit: 1,
    name: String(name || "").slice(0, 255),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.ok || !json.result?.invite_link) {
    throw new Error(`Telegram createChatInviteLink failed: http=${resp.status} body=${JSON.stringify(json).slice(0, 800)}`);
  }
  return json.result.invite_link;
}

async function webengageFireEvent({ userId, eventName, eventData }) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${WEBENGAGE_API_KEY}`,
    },
    body: JSON.stringify({ userId, eventName, eventData }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`WebEngage event failed: http=${resp.status} body=${text.slice(0, 800)}`);
  }
  return true;
}

// ======================
// Health
// ======================
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// ======================
// 1) Create invite (called by WebEngage Call API block)
// ======================
app.post("/create-invite", async (req, res) => {
  try {
    // Protect endpoint
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userId = String(req.body?.userId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();

    if (!userId || !transactionId) {
      return res.status(400).json({ ok: false, error: "Missing userId or transactionId" });
    }

    // Idempotency: if we already created for this txn, return existing
    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const existing = await txnRef.get();
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.inviteLink) {
        return res.json({ ok: true, inviteLink: data.inviteLink, reused: true });
      }
    }

    const linkName = `TB|txn:${transactionId}|uid:${userId}|t:${Date.now()}`.slice(0, 255);
    const inviteLink = await telegramCreateInviteLink(TELEGRAM_CHANNEL_ID, linkName);

    const invHash = hashInviteLink(inviteLink);

    // Write mapping (txn -> invite)
    await txnRef.set({
      userId,
      transactionId,
      inviteLink,
      inviteHash: invHash,
      createdAt: nowIso(),
      joined: false,
      telegramUserId: "",
      joinedAt: ""
    }, { merge: true });

    // Reverse mapping (invite -> txn)
    await db.collection(COL_INV).doc(invHash).set({
      inviteLink,
      inviteHash: invHash,
      transactionId,
      userId,
      createdAt: nowIso()
    }, { merge: true });

    return res.json({ ok: true, inviteLink, reused: false });
  } catch (e) {
    console.error("create-invite error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ======================
// 2) Telegram webhook (stores only relevant join updates; discards rest)
// ======================
app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};

    // Normalize update shape
    let upd = null;
    if (body.chat_member) upd = body.chat_member;
    else if (body.my_chat_member) upd = body.my_chat_member;
    else upd = body; // fallback (some forward inner object)

    const chatId = String(upd?.chat?.id || "").trim();
    const newStatus = String(upd?.new_chat_member?.status || "").trim();
    const telegramUserId = String(upd?.new_chat_member?.user?.id || "").trim();
    const inviteLink = String(upd?.invite_link?.invite_link || "").trim();

    // We only care about JOIN-like statuses
    const isJoinLike = (newStatus === "member" || newStatus === "administrator" || newStatus === "creator");

    // Single channel only
    if (chatId && chatId !== String(TELEGRAM_CHANNEL_ID)) {
      return res.status(200).send("ignored: other channel");
    }

    // If not join-like, discard fast (keeps webhook storage low)
    if (!isJoinLike) {
      return res.status(200).send("ignored: not a join");
    }

    // If join-like but missing inviteLink or telegramUserId, still store minimal “orphan”
    if (!inviteLink || !telegramUserId) {
      console.warn("Join-like but missing fields", { chatId, hasInviteLink: !!inviteLink, telegramUserId });
      return res.status(200).send("ok: missing fields");
    }

    const invHash = hashInviteLink(inviteLink);

    // Find mapping
    const invRef = db.collection(COL_INV).doc(invHash);
    const invSnap = await invRef.get();

    if (!invSnap.exists) {
      // Orphan webhook: store it (as you asked), but no WE fire possible yet
      await db.collection("orphan_joins").doc(`${invHash}_${Date.now()}`).set({
        inviteLink,
        inviteHash: invHash,
        chatId,
        telegramUserId,
        receivedAt: nowIso(),
        reason: "Invite not found in DB"
      });
      return res.status(200).send("ok: orphan stored");
    }

    const invData = invSnap.data() || {};
    const transactionId = String(invData.transactionId || "").trim();
    const userId = String(invData.userId || "").trim();

    if (!transactionId || !userId) {
      return res.status(200).send("ok: mapping incomplete");
    }

    const txnRef = db.collection(COL_TXN).doc(transactionId);

    // Transactional update + idempotency guard
    await db.runTransaction(async (t) => {
      const txnSnap = await t.get(txnRef);
      const txn = txnSnap.exists ? (txnSnap.data() || {}) : {};

      if (txn.joined === true) {
        // already processed
        return;
      }

      t.set(txnRef, {
        joined: true,
        telegramUserId,
        joinedAt: nowIso()
      }, { merge: true });
    });

    // Fire WebEngage joined event (only once per txn)
    if (FIRE_JOIN_EVENT) {
      await webengageFireEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: {
          transactionId,
          inviteLink,
          telegramUserId
        }
      });
    }

    return res.status(200).send("ok: join processed");
  } catch (e) {
    console.error("telegram-webhook error:", e);
    // Always 200 to Telegram to avoid retries storm; log internally
    return res.status(200).send("ok: error logged");
  }
});

// Cloud Run port
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
