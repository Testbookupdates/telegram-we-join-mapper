"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// Ensure fetch works in Cloud Run (Node 18+)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ==================== APP ==================== */

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ==================== ENV ==================== */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  WEBENGAGE_LICENSE_CODE, // e.g. ~2024b5d8
  WEBENGAGE_API_KEY,      // REST API KEY (server key)
  STORE_API_KEY,
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
} = process.env;

const SHOULD_FIRE_JOIN_EVENT = FIRE_JOIN_EVENT.toLowerCase() === "true";

if (
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHANNEL_ID ||
  !WEBENGAGE_LICENSE_CODE ||
  !WEBENGAGE_API_KEY ||
  !STORE_API_KEY
) {
  console.error("❌ Missing required environment variables");
}

/* ==================== DB ==================== */

const db = new Firestore();

const COL_TXN = "txn_invites";      // transactionId → invite
const COL_INV = "invite_lookup";    // inviteHash → transaction
const COL_ORPHAN = "orphan_joins";  // unmatched joins

/* ==================== HELPERS ==================== */

const nowIso = () => new Date().toISOString();
const unixSeconds = () => Math.floor(Date.now() / 1000);

function hashInviteLink(link) {
  return crypto.createHash("sha256").update(String(link)).digest("hex");
}

/* ==================== WEBENGAGE ==================== */

async function fireWebEngageEvent({ userId, eventName, eventData }) {
  const url = `https://api.in.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;
  const apiKey = WEBENGAGE_API_KEY.trim();

  const payload = {
    userId: String(userId),
    eventName,
    eventTime: unixSeconds(),
    eventData,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    console.log(`[WebEngage] ${eventName} | ${res.status} | ${body}`);

    if (!res.ok) throw new Error(body);
  } catch (err) {
    console.error(`[WebEngage Error] ${eventName}: ${err.message}`);
  }
}

/* ==================== TELEGRAM ==================== */

async function createTelegramInvite(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1,
      expire_date: unixSeconds() + 48 * 60 * 60,
      name: String(name).slice(0, 255),
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
  }

  return json.result.invite_link;
}

/* ==================== ROUTES ==================== */

app.get("/healthz", (_, res) => res.send("ok"));

/**
 * CREATE INVITE
 * Called by WebEngage Journey
 */
app.post("/create-invite", async (req, res) => {
  try {
    if (req.header("x-api-key") !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userId = String(req.body.userId || "").trim();
    const transactionId = String(req.body.transactionId || "").trim();

    if (!userId || !transactionId) {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const snap = await txnRef.get();

    let inviteLink;
    let reused = false;

    if (snap.exists && snap.data().inviteLink) {
      inviteLink = snap.data().inviteLink;
      reused = true;
    } else {
      inviteLink = await createTelegramInvite(
        TELEGRAM_CHANNEL_ID,
        `TB|${transactionId}|${userId}`
      );

      const inviteHash = hashInviteLink(inviteLink);

      await db.batch()
        .set(txnRef, {
          transactionId,
          userId,
          inviteLink,
          inviteHash,
          joined: false,
          createdAt: nowIso(),
        })
        .set(db.collection(COL_INV).doc(inviteHash), {
          transactionId,
          userId,
          inviteLink,
          createdAt: nowIso(),
        })
        .commit();
    }

    // Fire-and-forget analytics
    fireWebEngageEvent({
      userId: `pass_${userId}`,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink, reused },
    });

    res.json({ ok: true, inviteLink, reused });
  } catch (err) {
    console.error("/create-invite error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * TELEGRAM WEBHOOK
 * Confirms join and fires join event once
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const upd = req.body.chat_member || req.body.my_chat_member || {};
    const status = upd?.new_chat_member?.status;
    const inviteLink = upd?.invite_link?.invite_link;
    const telegramUserId = upd?.new_chat_member?.user?.id;
    const chatId = String(upd?.chat?.id || "");

    if (!["member", "administrator"].includes(status)) return res.send("ignored");
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("wrong channel");
    if (!inviteLink) return res.send("no invite link");

    const inviteHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(inviteHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).add({
        inviteLink,
        telegramUserId,
        createdAt: nowIso(),
        reason: "Invite not found",
      });
      return res.send("orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;
    await db.runTransaction(async t => {
      const snap = await t.get(txnRef);
      if (snap.exists && !snap.data().joined) {
        t.update(txnRef, {
          joined: true,
          telegramUserId,
          joinedAt: nowIso(),
        });
        shouldFire = true;
      }
    });

    if (shouldFire && SHOULD_FIRE_JOIN_EVENT) {
      fireWebEngageEvent({
        userId: `pass_${userId}`,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      });
    }

    res.send("ok");
  } catch (err) {
    console.error("/telegram-webhook error:", err.message);
    res.send("ok");
  }
});

/* ==================== SERVER ==================== */

app.listen(PORT, () => {
  console.log(`🚀 Telegram ↔ WebEngage Mapper running on port ${PORT}`);
});
