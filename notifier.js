import { Resend } from 'resend';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 Stunde Cooldown
const ALERT_FILE = path.resolve('.last_alerts.json');

export async function sendErrorAlert(context, error) {
  try {
    const now = Date.now();
    let currentData = {};

    // 1. Letzten Fehler-Status aus der Datei lesen
    try {
      const fileContent = await fs.readFile(ALERT_FILE, 'utf-8');
      currentData = JSON.parse(fileContent);
    } catch (e) {
      // Datei existiert noch nicht oder ist korrupt - ignorieren und leer starten
    }

    const lastAlertTime = currentData[context] || 0;

    // 2. Cooldown prüfen
    if (now - lastAlertTime < ALERT_COOLDOWN_MS) {
      console.warn(`[Notifier] Alert für '${context}' unterdrückt (Cooldown aktiv).`);
      return;
    }

    // 3. E-Mail versenden
    const errorMsg = error instanceof Error ? error.stack : String(error);
    
    await resend.emails.send({
      from: `WM Backend Alert <${process.env.ALERT_FROM_EMAIL}>`,
      to: [process.env.ALERT_TO_EMAIL],
      subject: `🚨 CRITICAL ERROR: ${context}`,
      html: `
        <h2>Fehler im WM 2026 Backend</h2>
        <p><strong>Kontext:</strong> ${context}</p>
        <p><strong>Zeitpunkt:</strong> ${new Date().toISOString()}</p>
        <hr>
        <h3>Stacktrace / Details:</h3>
        <pre style="background: #f4f4f4; padding: 10px; overflow-x: auto;">${errorMsg}</pre>
      `
    });

    // 4. Neuen Zeitstempel auf die Festplatte schreiben
    currentData[context] = now;
    await fs.writeFile(ALERT_FILE, JSON.stringify(currentData));

    console.log(`[Notifier] Notfall-E-Mail für '${context}' erfolgreich versendet.`);
  } catch (resendError) {
    console.error("[Notifier] Kritisch: Konnte Alert-E-Mail nicht senden!", resendError);
  }
}