"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ===== ENV ===== */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  WEBENGAGE_API_KEY,
  STORE_API_KEY,
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
} = process.env;

const SHOULD_FIRE_JOIN_EVENT = FIRE_JOIN_EVENT.toLowerCase() === "true";

/* ===== DB ===== */

const db = new Firestore();
const COL_TXN = "txn_invites";
const COL_INV = "invite_lookup";
const COL_ORPHAN = "orphan_joins";

/* ===== HELPERS ===== */

const nowIso = () => new Date().toISOString();

function hashInviteLink(link) {
  return crypto.createHash("sha256").update(String(link)).digest("hex");
}

/* ===== WEBENGAGE ===== */

async function fireWebEngageEvent({ userId, eventName, eventData }) {
  const res = await fetch("https://api.webengage.com/v1/events", {
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

  const body = await res.text();
  console.log(`[WebEngage] ${eventName} | ${res.status} | ${body}`);

  if (!res.ok) throw new Error(body);
}

/* ===== TELEGRAM ===== */

async function createTelegramInvite(channelId, name) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 48 * 60 * 60,
        name: String(name).slice(0, 255),
      }),
    }
  );

  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(JSON.stringify(json));
  return json.result.invite_link;
}

/* ===== ROUTES ===== */

app.get("/healthz", (_, res) => res.send("ok"));

app.post("/create-invite", async (req, res) => {
  try {
    if (req.header("x-api-key") !== STORE_API_KEY) {
      return res.status(401).json({ ok: false });
    }

    const userId = String(req.body.userId || "").trim();
    const transactionId = String(req.body.transactionId || "").trim();
    if (!userId || !transactionId) {
      return res.status(400).json({ ok: false });
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

    fireWebEngageEvent({
      userId: `pass_${userId}`,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink, reused },
    }).catch(() => {});

    res.json({ ok: true, inviteLink, reused });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ ok: false });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    const upd = req.body.chat_member || req.body.my_chat_member || {};
    const status = upd?.new_chat_member?.status;
    const inviteLink = upd?.invite_link?.invite_link;
    const telegramUserId = upd?.new_chat_member?.user?.id;
    const chatId = String(upd?.chat?.id || "");

    if (!["member", "administrator", "creator"].includes(status)) {
      return res.send("ignored");
    }

    if (chatId !== String(TELEGRAM_CHANNEL_ID) || !inviteLink) {
      return res.send("ignored");
    }

    const inviteHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(inviteHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).add({
        inviteLink,
        telegramUserId,
        createdAt: nowIso(),
      });
      return res.send("orphan");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;

    await db.runTransaction(async (t) => {
      const s = await t.get(txnRef);
      if (s.exists && !s.data().joined) {
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
      }).catch(() => {});
    }

    res.send("ok");
  } catch (e) {
    console.error(e.message);
    res.send("ok");
  }
});

/* ===== START ===== */

app.listen(PORT, () =>
  console.log(`🚀 Telegram ↔ WebEngage service running on ${PORT}`)
);
