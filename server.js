"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// Explicitly handle fetch for Node 18+ on Cloud Run
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============= ENV VARS =============
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  WEBENGAGE_LICENSE_CODE, // e.g., ~1234abcd
  WEBENGAGE_API_KEY,      // e.g., 00000000-0000-0000-0000-000000000000
  STORE_API_KEY,          // Shared secret between WebEngage and this server
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
} = process.env;

const SHOULD_FIRE_JOIN_EVENT = FIRE_JOIN_EVENT.toLowerCase() === "true";

// ============= DB INIT =============
const db = new Firestore();
const COL_TXN = "txn_invites";
const COL_INV = "invite_lookup";
const COL_ORPHAN = "orphan_joins";

// ============= HELPERS =============
const nowIso = () => new Date().toISOString();
const unixSeconds = () => Math.floor(Date.now() / 1000);

function hashInviteLink(inviteLink) {
  return crypto.createHash("sha256").update(String(inviteLink || "")).digest("hex");
}

// ============= WEBENGAGE API =============
async function webengageFireEvent({ userId, eventName, eventData }) {
  // Use .in region for Indian accounts (most common)
  const url = `https://api.in.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;

  // Trim key to remove accidental newline or space characters
  const cleanKey = (WEBENGAGE_API_KEY || "").trim();

  const payload = {
    userId: String(userId),     // Force String ID
    eventName,
    eventTime: unixSeconds(),   // FIX: Mandatory UNIX seconds integer
    eventData,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cleanKey}`, // FIX: Strictly formatted Bearer token
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    
    // Detailed logging for debugging
    console.log(`[WebEngage] ${eventName} | HTTP ${res.status} | Resp: ${body}`);

    if (!res.ok) throw new Error(`WE Error ${res.status}: ${body}`);
  } catch (err) {
    console.error(`[WebEngage Critical Failure] ${eventName}: ${err.message}`);
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
      member_limit: 1, // Single-use link
      expire_date: unixSeconds() + (48 * 60 * 60), // 48-hour validity
      name: String(name).slice(0, 255),
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(`Telegram API Error: ${JSON.stringify(json)}`);
  return json.result.invite_link;
}

// ============= ROUTES =============

app.get("/healthz", (_, res) => res.status(200).send("ok"));

/**
 * 1) CREATE INVITE
 * WebEngage triggers this. Creates link & fires link_created event.
 */
app.post("/create-invite", async (req, res) => {
  try {
    // API Key Protection
    if (req.header("x-api-key") !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userId = String(req.body.userId || "").trim();
    const transactionId = String(req.body.transactionId || "").trim();
    if (!userId || !transactionId) return res.status(400).json({ ok: false, error: "Missing parameters" });

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const snap = await txnRef.get();

    let inviteLink, reused = false;

    // Idempotency: Return existing link if already generated
    if (snap.exists && snap.data().inviteLink) {
      inviteLink = snap.data().inviteLink;
      reused = true;
    } else {
      inviteLink = await telegramCreateInviteLink(
        TELEGRAM_CHANNEL_ID,
        `TB|${transactionId}|${userId}`
      );

      const invHash = hashInviteLink(inviteLink);

      await db.batch()
        .set(txnRef, { userId, transactionId, inviteLink, inviteHash: invHash, joined: false, createdAt: nowIso() })
        .set(db.collection(COL_INV).doc(invHash), { transactionId, userId, inviteLink, createdAt: nowIso() })
        .commit();
    }

    // Fire-and-forget Link Created Event
    webengageFireEvent({
      userId: `pass_${userId}`, // Namespacing
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink, reused },
    }).catch(e => console.error("Async Event Error:", e.message));

    res.json({ ok: true, inviteLink, reused });
  } catch (e) {
    console.error(`[/create-invite] Failure: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 2) TELEGRAM WEBHOOK
 * Listens for new members and confirms join.
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const upd = body.chat_member || body.my_chat_member || {};
    const status = upd?.new_chat_member?.status;
    const inviteLink = upd?.invite_link?.invite_link;
    const telegramUserId = upd?.new_chat_member?.user?.id;
    const chatId = String(upd?.chat?.id || "");

    if (!["member", "administrator"].includes(status)) return res.send("ignored: not a join");
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("ignored: wrong channel");
    if (!inviteLink) return res.send("ignored: no link detected");

    const invHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(invHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).add({ inviteLink, telegramUserId, createdAt: nowIso(), reason: "Link not in database" });
      return res.send("ok: orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let fireJoined = false;
    await db.runTransaction(async t => {
      const s = await t.get(txnRef);
      if (s.exists && !s.data().joined) {
        t.update(txnRef, { joined: true, telegramUserId, joinedAt: nowIso() });
        fireJoined = true;
      }
    });

    if (fireJoined && SHOULD_FIRE_JOIN_EVENT) {
      webengageFireEvent({
        userId: `pass_${userId}`,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      }).catch(e => console.error("Async Event Error:", e.message));
    }

    res.send("ok: join confirmed");
  } catch (e) {
    console.error(`[Webhook] Error: ${e.message}`);
    res.status(200).send("ok: error logged"); 
  }
});

app.listen(PORT, () => console.log(`🚀 Final Stable API listening on port ${PORT}`));
