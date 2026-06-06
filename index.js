import cron from 'node-cron';
import { syncLiveMatches } from './syncLiveMatches.js';
import { fetchLineupsForUpcomingMatches } from './preMatchWorker.js';
import { runDailySync } from './dailyWorker.js';
import { sendErrorAlert } from './notifier.js';
import { runFixedReminders } from './scheduledReminders.js';
import { placeBotBets } from './botWorker.js';

// --- GLOBALE FEHLERABFANGUNG ---
process.on('uncaughtException', async (error) => {
  console.error("UNCAUGHT EXCEPTION! Prozess stürzt ab...", error);
  await sendErrorAlert('Global Uncaught Exception', error);
  process.exit(1); 
});

process.on('unhandledRejection', async (reason) => {
  console.error("UNHANDLED REJECTION! Promise nicht gecatcht...", reason);
  await sendErrorAlert('Global Unhandled Rejection', reason);
});
// -------------------------------

let isSyncing = false; 
let isPreMatchChecking = false;
let isDailySyncing = false;
let isMorningReminderRunning = false;
let isEveningReminderRunning = false;
let isBotRunning = false;

console.log(`[${new Date().toISOString()}] WM 2026 Backend Scheduler gestartet...`);

// 1. Live-Sync (Jede Minute)
cron.schedule('* * * * *', async () => {
  if (isSyncing) return;
  isSyncing = true;
  try {
    await syncLiveMatches();
  } catch (error) {
    console.error("Kritischer Fehler im Live-Sync-Zyklus:", error);
    await sendErrorAlert('Cron: Live-Sync', error);
  } finally {
    isSyncing = false;
  }
});

// 2. Pre-Match Check & 2h-Reminder (Alle 5 Minuten)
cron.schedule('*/5 * * * *', async () => {
  if (isPreMatchChecking) return;
  isPreMatchChecking = true;
  try {
    await fetchLineupsForUpcomingMatches();
  } catch (error) {
    console.error("Kritischer Fehler im Pre-Match-Zyklus:", error);
    await sendErrorAlert('Cron: Pre-Match', error);
  } finally {
    isPreMatchChecking = false;
  }
});

// 3. Daily Sync (Täglich um 02:00 Uhr nachts)
cron.schedule('0 2 * * *', async () => {
  if (isDailySyncing) return;
  isDailySyncing = true;
  try {
    await runDailySync();
  } catch (error) {
    console.error("Kritischer Fehler im täglichen Sync (02:00 Uhr):", error);
    await sendErrorAlert('Cron: Daily-Sync', error);
  } finally {
    isDailySyncing = false;
  }
});

// 4. Morning-Reminder: 24h Vorschau (Täglich um 08:00 Uhr)
cron.schedule('0 8 * * *', async () => {
  if (isMorningReminderRunning) return;
  isMorningReminderRunning = true;
  try {
    await runFixedReminders(24, 'Spiele der nächsten 24 Stunden');
  } catch (error) {
    console.error("Kritischer Fehler im Morning-Reminder:", error);
    await sendErrorAlert('Cron: Morning-Reminder', error);
  } finally {
    isMorningReminderRunning = false;
  }
});

// 5. Evening-Reminder: 12h Vorschau (Täglich um 18:00 Uhr)
cron.schedule('0 18 * * *', async () => {
  if (isEveningReminderRunning) return;
  isEveningReminderRunning = true;
  try {
    await runFixedReminders(12, 'Spiele der heutigen Nacht / Abend');
  } catch (error) {
    console.error("Kritischer Fehler im Evening-Reminder:", error);
    await sendErrorAlert('Cron: Evening-Reminder', error);
  } finally {
    isEveningReminderRunning = false;
  }
});
// 6. Bot-Wetten platzieren (Alle 10 Minuten)
cron.schedule('*/10 * * * *', async () => {
  if (isBotRunning) return;
  isBotRunning = true;
  try {
    await placeBotBets();
  } catch (error) {
    console.error("Kritischer Fehler im Bot-Zyklus:", error);
    await sendErrorAlert('Cron: Bot-Tipps', error);
  } finally {
    isBotRunning = false;
  }
});

// // ACHTUNG: Nur für den kurzen PM2-Test aktivieren!
// setTimeout(() => {
//     throw new Error("Fataler PM2 Crash-Test! Prüfe Absturz und Cooldown.");
// }, 10000); // Provoziert 10 Sekunden nach dem Start einen harten Absturz