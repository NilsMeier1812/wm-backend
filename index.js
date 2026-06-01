import cron from 'node-cron';
import { syncLiveMatches } from './syncLiveMatches.js';
import { fetchLineupsForUpcomingMatches } from './preMatchWorker.js';
import { runDailySync } from './dailyWorker.js';
import { sendErrorAlert } from './notifier.js';

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

console.log(`[${new Date().toISOString()}] WM 2026 Backend Scheduler gestartet...`);

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

// // ACHTUNG: Nur für den kurzen PM2-Test aktivieren!
// setTimeout(() => {
//     throw new Error("Fataler PM2 Crash-Test! Prüfe Absturz und Cooldown.");
// }, 10000); // Provoziert 10 Sekunden nach dem Start einen harten Absturz