import { sendErrorAlert } from './notifier.js';

async function runTest() {
  console.log("Starte Alert-Test...");
  try {
    // Wir simulieren einen Fehlerbefehl
    throw new Error("Dies ist ein manuell ausgelöster Test-Fehler zur Überprüfung der Resend-Integration.");
  } catch (error) {
    console.log("Fehler gefangen, sende Alert...");
    // Wir nutzen einen eindeutigen Kontext, um echte Fehler nicht mit dem Cooldown zu blockieren
    await sendErrorAlert('Manueller Test-Trigger', error);
    console.log("✅ sendErrorAlert durchgelaufen. Bitte Postfach prüfen.");
    console.log("Hinweis: Wenn du das Skript jetzt direkt nochmal ausführst, MUSS der Cooldown greifen und es darf keine Mail versendet werden.");
  }
}

runTest();