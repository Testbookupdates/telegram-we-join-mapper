"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============= ENV VARS =============
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  TELEGRAM_WEBHOOK_SECRET,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  STORE_API_KEY,
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
  // Default to global, change to 'api.in.webengage.com' if on India cluster
  WEBENGAGE_HOST = "api.webengage.com" 
} = process.env;

// ============= DB INIT =============
const db = new Firestore();
const COL_TXN = "txn_invites";
const COL_INV = "invite_lookup";
const COL_ORPHAN = "orphan_joins";

// ============= HELPERS =============
const nowIso = () => new Date().toISOString();
const unixSeconds = () => Math.floor(Date.now() / 1000);
const hash = (s) => crypto.createHash("sha256").update(String(s || "")).digest("hex");

// ============= WEBENGAGE API =============
async function webengageFireEvent({ userId, eventName, eventData }) {
  // URL Structure: https://<host>/v1/accounts/<license_code>/events
  const url = `https://${WEBENGAGE_HOST}/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify({
        userId: String(userId),
        eventName,
        eventData: eventData || {},
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[WebEngage] Error ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error(`[WebEngage Critical] ${err.message}`);
  }
}

// ============= TELEGRAM API =============
async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1,
      expire_date: unixSeconds() + (48 * 60 * 60), // 48 hours
      name: String(name).slice(0, 255),
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(`Telegram API Error: ${JSON.stringify(json)}`);
  return json.result.invite_link;
}

// ============= ROUTES =============

app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.post("/create-invite", async (req, res) => {
  try {
    if (req.header("x-api-key") !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { userId, transactionId } = req.body;
    if (!userId || !transactionId) return res.status(400).json({ ok: false, error: "Missing parameters" });

    const txnRef = db.collection(COL_TXN).doc(String(transactionId));

    // Use transaction to prevent duplicate link generation
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(txnRef);

      if (doc.exists && doc.data().inviteLink) {
        return { inviteLink: doc.data().inviteLink, reused: true };
      }

      const inviteLink = await telegramCreateInviteLink(
        TELEGRAM_CHANNEL_ID,
        `TB|${transactionId}|${userId}`
      );
      
      const invHash = hash(inviteLink);
      const invRef = db.collection(COL_INV).doc(invHash);

      t.set(txnRef, { userId, transactionId, inviteLink, inviteHash: invHash, joined: false, createdAt: nowIso() });
      t.set(invRef, { transactionId, userId, inviteLink, createdAt: nowIso() });

      return { inviteLink, reused: false };
    });

    // Fire event asynchronously
    webengageFireEvent({
      userId: `pass_${userId}`,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink: result.inviteLink, reused: result.reused },
    });

    res.json({ ok: true, ...result });

  } catch (e) {
    console.error(`[/create-invite] Failure: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    // 1. Security Check
    if (req.headers["x-telegram-bot-api-secret-token"] !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(403).send("Forbidden");
    }

    const body = req.body || {};
    const upd = body.chat_member || body.my_chat_member || {};
    
    // 2. Data Extraction
    const status = upd?.new_chat_member?.status;
    const inviteLink = upd?.invite_link?.invite_link;
    const telegramUserId = upd?.new_chat_member?.user?.id;
    const chatId = String(upd?.chat?.id || "");

    // 3. Filtering
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("ignored: wrong channel");
    if (!["member", "administrator"].includes(status)) return res.send("ignored: not a join");
    if (!inviteLink) return res.send("ignored: no link detected");

    // 4. Lookup
    const invHash = hash(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(invHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).add({ inviteLink, telegramUserId, createdAt: nowIso(), reason: "Link not in database" });
      return res.send("ok: orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);
    let fireJoined = false;

    // 5. Atomic Update
    await db.runTransaction(async (t) => {
      const s = await t.get(txnRef);
      if (s.exists && !s.data().joined) {
        t.update(txnRef, { joined: true, telegramUserId, joinedAt: nowIso() });
        fireJoined = true;
      }
    });

    // 6. Sync to WebEngage
    if (fireJoined && FIRE_JOIN_EVENT.toLowerCase() === "true") {
      webengageFireEvent({
        userId: `pass_${userId}`,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      });
    }

    res.send("ok: join confirmed");

  } catch (e) {
    console.error(`[Webhook] Error: ${e.message}`);
    res.status(200).send("ok: error logged"); 
  }
});

app.listen(PORT, () => console.log(`🚀 API listening on port ${PORT}`));
