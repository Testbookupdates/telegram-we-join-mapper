"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// Ensure fetch exists in Cloud Run (Node 18+)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: "1mb" }));

// ================= ENV =================
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  STORE_API_KEY,
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
} = process.env;

const SHOULD_FIRE_JOIN_EVENT = FIRE_JOIN_EVENT.toLowerCase() === "true";

// ================= DB =================
const db = new Firestore();

const COL_TXN = "txn_invites";
const COL_INV = "invite_lookup";
const COL_ORPHAN = "orphan_joins";

// ================= HELPERS =================
const nowIso = () => new Date().toISOString();
const unixSeconds = () => Math.floor(Date.now() / 1000);

function hashInviteLink(inviteLink) {
  return crypto.createHash("sha256").update(String(inviteLink)).digest("hex");
}

// ================= WEBENGAGE =================
async function webengageFireEvent({ userId, eventName, eventData }) {
  // FIX: Using the India Region endpoint explicitly
  const url = `https://api.in.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;

  const payload = {
    userId: String(userId), // Namespaced ID (e.g., pass_123)
    eventName,
    eventTime: unixSeconds(),
    eventData,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    console.log(`[WebEngage] ${eventName} | Status: ${res.status} | Body: ${body}`);

    if (!res.ok) throw new Error(body);
  } catch (err) {
    console.error(`[WebEngage Failure] ${eventName}: ${err.message}`);
  }
}

// ================= TELEGRAM =================
async function telegramCreateInviteLink(channelId, name) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        member_limit: 1,
        expire_date: unixSeconds() + 48 * 60 * 60, // 48h expiry
        name: name.slice(0, 255),
      }),
    }
  );

  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error("Telegram error: " + JSON.stringify(json));
  return json.result.invite_link;
}

// ================= ROUTES =================
app.get("/healthz", (_, res) => res.send("ok"));

/**
 * 1) CREATE INVITE
 */
app.post("/create-invite", async (req, res) => {
  try {
    if (req.header("x-api-key") !== STORE_API_KEY) return res.status(401).json({ ok: false });

    const userId = String(req.body.userId || "").trim();
    const transactionId = String(req.body.transactionId || "").trim();
    if (!userId || !transactionId) return res.status(400).json({ ok: false });

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const snap = await txnRef.get();

    let inviteLink, reused = false;

    if (snap.exists && snap.data().inviteLink) {
      inviteLink = snap.data().inviteLink;
      reused = true;
    } else {
      inviteLink = await telegramCreateInviteLink(
        TELEGRAM_CHANNEL_ID,
        `TB|${transactionId}|${userId}|${Date.now()}`
      );

      const invHash = hashInviteLink(inviteLink);

      await db.batch()
        .set(txnRef, { userId, transactionId, inviteLink, inviteHash: invHash, joined: false, createdAt: nowIso() })
        .set(db.collection(COL_INV).doc(invHash), { transactionId, userId, inviteLink, createdAt: nowIso() })
        .commit();
    }

    // Fire-and-forget analytics (don't wait for WE to respond to finish the API call)
    webengageFireEvent({
      userId: `pass_${userId}`, // Namespacing for clean segmentation
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink, reused },
    }).catch(e => console.error("WE Link Event Error:", e.message));

    res.json({ ok: true, inviteLink, reused });
  } catch (e) {
    console.error("Create-Invite Error:", e);
    res.status(500).json({ ok: false });
  }
});

/**
 * 2) TELEGRAM WEBHOOK
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const upd = req.body.chat_member || req.body.my_chat_member || {};
    const status = upd?.new_chat_member?.status;
    const inviteLink = upd?.invite_link?.invite_link;
    const telegramUserId = upd?.new_chat_member?.user?.id;
    const chatId = String(upd?.chat?.id);

    if (!["member", "administrator"].includes(status)) return res.send("ignored");
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("wrong channel");
    if (!inviteLink) return res.send("no link");

    const invHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(invHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).add({ inviteLink, telegramUserId, createdAt: nowIso(), reason: "Not in DB" });
      return res.send("orphan");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let fire = false;
    await db.runTransaction(async t => {
      const s = await t.get(txnRef);
      if (s.exists && !s.data().joined) {
        t.update(txnRef, { joined: true, telegramUserId, joinedAt: nowIso() });
        fire = true;
      }
    });

    if (fire && SHOULD_FIRE_JOIN_EVENT) {
      webengageFireEvent({
        userId: `pass_${userId}`,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      }).catch(e => console.error("WE Join Event Error:", e.message));
    }

    res.send("ok");
  } catch (e) {
    console.error("Webhook Error:", e);
    res.status(200).send("ok"); // Always 200 to Telegram
  }
});

app.listen(PORT, () => console.log(`🚀 Bridge Online on port ${PORT}`));
