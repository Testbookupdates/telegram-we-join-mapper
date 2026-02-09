"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

/**
 * ARCHITECTURE:
 * 1. WebEngage calls /create-invite with userId and transactionId.
 * 2. This server generates a single-use Telegram link and stores the mapping in Firestore.
 * 3. Telegram sends a webhook when a user joins the channel.
 * 4. This server matches the link, finds the transaction, and fires 'pass_paid_community_telegram_joined' to WebEngage.
 */

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============= ENV VARS =============
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

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !WEBENGAGE_LICENSE_CODE || !WEBENGAGE_API_KEY || !STORE_API_KEY) {
  console.error("❌ Missing required env vars. Check TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, WEBENGAGE_LICENSE_CODE, WEBENGAGE_API_KEY, STORE_API_KEY");
}

const db = new Firestore();

// Collections
const COL_TXN = "txn_invites";    // docId = transactionId
const COL_INV = "invite_lookup";  // docId = hash(inviteLink)
const COL_ORPHAN = "orphan_joins"; // Stores joins that didn't match an active invite

// Helpers
const nowIso = () => new Date().toISOString();

function hashInviteLink(inviteLink) {
  return crypto.createHash("sha256").update(String(inviteLink || "")).digest("hex");
}

// --- Telegram API ---

async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1, // Single-use link
      name: String(name || "").slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok || !data.result?.invite_link) {
    throw new Error(`Telegram Error: ${JSON.stringify(data)}`);
  }
  return data.result.invite_link;
}

// --- WebEngage API ---

async function webengageFireEvent({ userId, eventName, eventData }) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WEBENGAGE_API_KEY}`,
    },
    body: JSON.stringify({ userId, eventName, eventData }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`WebEngage Error: ${res.status} - ${errorText}`);
  }
  return true;
}

// --- Endpoints ---

app.get("/healthz", (_, res) => res.status(200).send("ok"));

/**
 * 1) CREATE INVITE
 * Called by WebEngage Journey "Call API" block.
 * Expects: { "userId": "...", "transactionId": "..." }
 */
app.post("/create-invite", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userId = String(req.body?.userId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();

    if (!userId || !transactionId) {
      return res.status(400).json({ ok: false, error: "Missing userId or transactionId" });
    }

    // Idempotency: Return existing link if already generated for this transaction
    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const txnSnap = await txnRef.get();
    if (txnSnap.exists && txnSnap.data()?.inviteLink) {
      return res.json({ ok: true, inviteLink: txnSnap.data().inviteLink, reused: true });
    }

    const linkName = `TB|txn:${transactionId}|uid:${userId}|${Date.now()}`.slice(0, 255);
    const inviteLink = await telegramCreateInviteLink(TELEGRAM_CHANNEL_ID, linkName);
    const invHash = hashInviteLink(inviteLink);

    // Atomic write of the mappings
    const batch = db.batch();
    
    // Primary transaction record
    batch.set(txnRef, {
      userId,
      transactionId,
      inviteLink,
      inviteHash: invHash,
      createdAt: nowIso(),
      joined: false,
      telegramUserId: "",
      joinedAt: ""
    }, { merge: true });
    
    // Fast lookup record (hashed link -> transaction metadata)
    batch.set(db.collection(COL_INV).doc(invHash), {
      transactionId,
      userId,
      inviteLink,
      createdAt: nowIso(),
    }, { merge: true });

    await batch.commit();

    res.json({ ok: true, inviteLink, reused: false });
  } catch (err) {
    console.error(`[Error] /create-invite: ${err.message}`);
    res.status(500).json({ ok: true, error: err.message });
  }
});

/**
 * 2) TELEGRAM WEBHOOK
 * Telegram calls this when status changes. We filter for joins in our channel.
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const upd = body.chat_member || body.my_chat_member || body;

    const chatId = String(upd?.chat?.id || "").trim();
    const newStatus = String(upd?.new_chat_member?.status || "").trim();
    const telegramUserId = String(upd?.new_chat_member?.user?.id || "").trim();
    const inviteLink = String(upd?.invite_link?.invite_link || "").trim();

    // 1. Status Filter: Only process joining members
    const isJoinLike = ["member", "administrator", "creator"].includes(newStatus);
    if (!isJoinLike) return res.send("ignored: not a join");

    // 2. Channel Filter: Ensure it's the correct channel
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("ignored: wrong channel");

    // 3. Link Validation
    if (!inviteLink || !telegramUserId) {
      console.warn("Join detected but inviteLink or telegramUserId is missing");
      return res.send("ok: missing fields");
    }

    const invHash = hashInviteLink(inviteLink);
    const invRef = db.collection(COL_INV).doc(invHash);
    const invSnap = await invRef.get();

    // 4. Mapping Lookup
    if (!invSnap.exists) {
      // Store "Orphan" joins (user joined with a link not in our database)
      await db.collection(COL_ORPHAN).doc(`${invHash}_${Date.now()}`).set({
        inviteLink,
        inviteHash: invHash,
        telegramUserId,
        receivedAt: nowIso(),
        reason: "Invite not found in database"
      });
      return res.send("ok: orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;

    // 5. Transactional Join Update
    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (!snap.exists || snap.data().joined) return;

      t.update(txnRef, {
        joined: true,
        telegramUserId,
        joinedAt: nowIso()
      });
      shouldFire = true;
    });

    // 6. WebEngage Sync
    if (shouldFire && SHOULD_FIRE_JOIN_EVENT) {
      await webengageFireEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: {
          transactionId,
          inviteLink,
          telegramUserId
        },
      });
    }

    res.send("ok: join processed");
  } catch (err) {
    console.error(`[Webhook Error] ${err.message}`);
    res.status(200).send("ok: error logged"); 
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
