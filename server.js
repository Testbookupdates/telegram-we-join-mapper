"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// FIX: Explicitly handle fetch for Node runtimes that don't have it globally
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
  console.error("❌ Missing required env vars. Check deployment settings.");
}

const db = new Firestore();

// Collections
const COL_TXN = "txn_invites";    // docId = transactionId
const COL_INV = "invite_lookup";  // docId = hash(inviteLink)
const COL_ORPHAN = "orphan_joins"; 

// Helpers
const nowIso = () => new Date().toISOString();

function hashInviteLink(inviteLink) {
  return crypto.createHash("sha256").update(String(inviteLink || "")).digest("hex");
}

// --- WebEngage API ---
// FIX: Enhanced logging and forced String userId to prevent silent drops
async function webengageFireEvent({ userId, eventName, eventData }) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;
  
  const payload = {
    userId: String(userId), // CRITICAL: WE requires string ID
    eventName,
    eventTime: nowIso(),
    eventData
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    console.log(`[WebEngage] ${eventName} | Status: ${res.status} | Response: ${body}`);

    if (!res.ok) {
      throw new Error(`WebEngage Error: ${res.status} - ${body}`);
    }
    return true;
  } catch (err) {
    console.error(`[WebEngage Failure] ${eventName}: ${err.message}`);
    return false;
  }
}

// --- Telegram API ---
async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  
  // Set link to expire in 48 hours for security
  const expireDate = Math.floor(Date.now() / 1000) + (48 * 60 * 60);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1, 
      expire_date: expireDate,
      name: String(name || "").slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok || !data.result?.invite_link) {
    throw new Error(`Telegram Error: ${JSON.stringify(data)}`);
  }
  return data.result.invite_link;
}

// --- Endpoints ---

app.get("/healthz", (_, res) => res.status(200).send("ok"));

/**
 * 1) CREATE INVITE
 * Now fires 'pass_paid_community_telegram_link_created' directly
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

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const txnSnap = await txnRef.get();
    
    let inviteLink;
    let reused = false;

    if (txnSnap.exists && txnSnap.data()?.inviteLink) {
      inviteLink = txnSnap.data().inviteLink;
      reused = true;
    } else {
      const linkName = `TB|txn:${transactionId}|uid:${userId}|${Date.now()}`.slice(0, 255);
      inviteLink = await telegramCreateInviteLink(TELEGRAM_CHANNEL_ID, linkName);
      const invHash = hashInviteLink(inviteLink);

      const batch = db.batch();
      batch.set(txnRef, {
        userId, transactionId, inviteLink, inviteHash: invHash,
        createdAt: nowIso(), joined: false
      }, { merge: true });
      
      batch.set(db.collection(COL_INV).doc(invHash), {
        transactionId, userId, inviteLink, createdAt: nowIso(),
      }, { merge: true });

      await batch.commit();
    }

    // FIRE LINK CREATED EVENT
    await webengageFireEvent({
      userId,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink, reused }
    });

    res.json({ ok: true, inviteLink, reused });
  } catch (err) {
    console.error(`[Error] /create-invite: ${err.message}`);
    // FIX: ok: false so Journey can handle the error path
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 2) TELEGRAM WEBHOOK
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const upd = body.chat_member || body.my_chat_member || body;

    const chatId = String(upd?.chat?.id || "").trim();
    const newStatus = String(upd?.new_chat_member?.status || "").trim();
    const telegramUserId = String(upd?.new_chat_member?.user?.id || "").trim();
    const inviteLink = String(upd?.invite_link?.invite_link || "").trim();

    if (!["member", "administrator", "creator"].includes(newStatus)) return res.send("ignored");
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("wrong channel");
    if (!inviteLink) return res.send("no link");

    const invHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(invHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).doc(`${invHash}_${Date.now()}`).set({
        inviteLink, inviteHash: invHash, telegramUserId, receivedAt: nowIso(), reason: "Not in DB"
      });
      return res.send("orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;
    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (!snap.exists || snap.data().joined) return;
      t.update(txnRef, { joined: true, telegramUserId, joinedAt: nowIso() });
      shouldFire = true;
    });

    if (shouldFire && SHOULD_FIRE_JOIN_EVENT) {
      await webengageFireEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      });
    }

    res.send("ok");
  } catch (err) {
    console.error(`[Webhook Error] ${err.message}`);
    res.status(200).send("error logged"); 
  }
});

app.listen(PORT, () => console.log(`🚀 Telegram-WebEngage Mapper online on port ${PORT}`));
