import axios from 'axios';
import { supabase } from './supabaseClient.js';
import dotenv from 'dotenv';

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const SAFE_MODE_THRESHOLD = 6000;

// Fail-Fast: Verhindert den Start des Workers, wenn Konfiguration fehlt
if (!API_KEY) {
  console.error("Kritischer Architekturfehler: API_FOOTBALL_KEY ist in der .env Datei nicht definiert.");
  process.exit(1);
}

/**
 * Prüft das tägliche API-Limit in der Supabase.
 * Verhindert, dass durch einen Amok laufenden Cron-Job Kosten entstehen oder
 * der API-Account gesperrt wird.
 */
export async function checkApiLimits() {
  const { data, error } = await supabase
    .from('system_state')
    .select('count_calls')
    .single();

  if (error) {
    console.error("Datenbankfehler beim Abrufen des API-Counters:", error.message);
    return false; // Sicherheitsblockade bei DB-Ausfall
  }

  if (data && data.count_calls >= SAFE_MODE_THRESHOLD) {
    console.warn(`SAFE MODE AKTIV: API-Limit von ${SAFE_MODE_THRESHOLD} erreicht. Abfrage blockiert.`);
    return false;
  }
  
  return true;
}

/**
 * Erhöht den API-Aufrufzähler in der Datenbank.
 */
async function incrementApiCounter() {
  const { data: currentState, error: fetchError } = await supabase
    .from('system_state')
    .select('count_calls')
    .single();
  
  if (fetchError || !currentState) {
    console.error("Fehler beim Lesen des system_state für Inkrementierung.");
    return;
  }

  const { error: updateError } = await supabase
    .from('system_state')
    .update({ count_calls: currentState.count_calls + 1 })
    .eq('id', 1); // Nimmt an, dass die Zeile in system_state die ID 1 hat

  if (updateError) {
    console.error("Fehler beim Schreiben des inkrementierten API-Counters:", updateError.message);
  }
}

/**
 * Holt alle aktuell laufenden Spiele der WM 2026.
 */
export async function fetchLiveFixtures() {
  const canFetch = await checkApiLimits();
  if (!canFetch) return null;

  try {
    const response = await axios.get(`${API_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: {
        live: 'all', 
        league: 10, // World Cup
        season: 2026
      }
    });

    await incrementApiCounter();
    
    // Fehlerüberprüfung der API-Antwortstruktur
    if (response.data && response.data.errors && Object.keys(response.data.errors).length > 0) {
       console.error("API-Sports meldet Fehler:", response.data.errors);
       return null;
    }

    return response.data.response;
  } catch (error) {
    console.error("Verbindungsfehler zur API-Football (/fixtures):", error.message);
    return null;
  }
}

/**
 * Ermittelt den ersten Torschützen eines spezifischen Spiels.
 * Filtert annullierte Tore (VAR) heraus.
 */
export async function fetchFirstGoalscorer(apiMatchId) {
  const canFetch = await checkApiLimits();
  if (!canFetch) return null;

  try {
    const response = await axios.get(`${API_URL}/fixtures/events`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { 
        fixture: apiMatchId, 
        type: 'Goal' 
      }
    });

    await incrementApiCounter();

    const events = response.data.response;
    if (!events || !Array.isArray(events) || events.length === 0) return null;

    // Filtert das erste valide Tor.
    // 'event.detail' enthält i.d.R. "Normal Goal", "Own Goal", "Penalty". 
    // Stornierungen enthalten meist "cancelled".
    const firstGoal = events.find(event => 
      event.type === 'Goal' && 
      event.detail && 
      !event.detail.toLowerCase().includes('cancelled')
    );

    return firstGoal && firstGoal.player ? firstGoal.player.id : null;
  } catch (error) {
    console.error(`Verbindungsfehler bei Event-Abfrage für Spiel ${apiMatchId}:`, error.message);
    return null;
  }
}
/**
 * Tendenz eines Tipps: 1 = Heimsieg, 0 = Unentschieden, -1 = Auswärtssieg.
 * Gibt null zurück, wenn der Tipp unvollständig ist (kein Score getippt).
 */
export function betTendency(bet) {
  if (bet.home_score === null || bet.home_score === undefined ||
      bet.away_score === null || bet.away_score === undefined) {
    return null;
  }
  return Math.sign(parseInt(bet.home_score, 10) - parseInt(bet.away_score, 10));
}

/**
 * Torschützen-Schlüssel eines Tipps: Spieler-ID (als String), 'goalless' bei
 * Tipp "Kein Tor", oder null wenn der Torschützen-Tipp unvollständig ist.
 */
export function betScorerKey(bet) {
  if (bet.is_goalless === true) return 'goalless';
  if (bet.first_goalscorer_id !== null && bet.first_goalscorer_id !== undefined) {
    return String(bet.first_goalscorer_id);
  }
  return null;
}

/**
 * Ermittelt für einen einzelnen Tipp, ob er ein Underdog-Tipp ist – also ob er
 * der EINZIGE korrekte Tipp unter allen abgegebenen Tipps des Spiels ist.
 *
 * @param {object} bet            Der zu prüfende Tipp.
 * @param {object[]} allBets      Alle Tipps des Spiels (inkl. bet selbst).
 * @param {number|string} actualHome  Tatsächliche Heim-Tore (inkl. Verlängerung).
 * @param {number|string} actualAway  Tatsächliche Auswärts-Tore (inkl. Verlängerung).
 * @param {string|null} actualScorerKey  Tatsächlicher Torschützen-Schlüssel:
 *        Spieler-ID (String), 'goalless', oder null (kein valider Schütze bekannt).
 * @returns {{isUnderdogTendency: boolean, isUnderdogScorer: boolean}}
 */
export function computeUnderdogFlags(bet, allBets, actualHome, actualAway, actualScorerKey) {
  const result = { isUnderdogTendency: false, isUnderdogScorer: false };
  if (!Array.isArray(allBets) || allBets.length === 0) return result;

  // --- Tendenz-Underdog ---
  const actualTendency = Math.sign(parseInt(actualHome, 10) - parseInt(actualAway, 10));
  const myTendency = betTendency(bet);
  if (myTendency !== null && myTendency === actualTendency) {
    const correctCount = allBets.filter(b => betTendency(b) === actualTendency).length;
    if (correctCount === 1) result.isUnderdogTendency = true;
  }

  // --- Torschützen-Underdog ('goalless' zählt mit) ---
  const myScorerKey = betScorerKey(bet);
  if (actualScorerKey !== null && myScorerKey !== null && myScorerKey === actualScorerKey) {
    const correctCount = allBets.filter(b => betScorerKey(b) === actualScorerKey).length;
    if (correctCount === 1) result.isUnderdogScorer = true;
  }

  return result;
}

export function calculatePoints(actualHome, actualAway, betHome, betAway, actualScorer, betScorer, actualIsGoalless = false, betIsGoalless = false, betIsBoosted = false, isUnderdogTendency = false, isUnderdogScorer = false) {
  // Integritätsprüfung
  if (
    actualHome === null || actualHome === undefined ||
    actualAway === null || actualAway === undefined ||
    betHome === null || betHome === undefined ||
    betAway === null || betAway === undefined
  ) {
    return 0; // Tipp unvollständig
  }

  const aHome = parseInt(actualHome, 10);
  const aAway = parseInt(actualAway, 10);
  const bHome = parseInt(betHome, 10);
  const bAway = parseInt(betAway, 10);

  let points = 0;

  const actualDiff = aHome - aAway;
  const betDiff = bHome - bAway;
  
  const actualTendency = Math.sign(actualDiff);
  const betTendency = Math.sign(betDiff);

  // 1. Auswertung des Spielausgangs
  if (aHome === bHome && aAway === bAway) {
    points += 3; // Exaktes Ergebnis
  } else if (actualDiff === betDiff) {
    points += 2; // Tordifferenz korrekt
  } else if (actualTendency === betTendency) {
    points += 1; // Tendenz korrekt
  }

  // 2. Auswertung des Torschützen
  if (actualIsGoalless) {
      if (betIsGoalless) {
          points += 1; // User hat korrekt auf 0 Tore getippt
      }
  } else if (actualScorer !== null && actualScorer !== undefined) {
      // Es gab einen Torschützen. Hat der User genau diesen getippt?
      if (betScorer !== null && String(actualScorer) === String(betScorer)) {
        points += 1;
      }
  }

  // 3. Underdog-Boni: je +1, wenn der User der einzige korrekte Tipper ist.
  //    Zählen zur Basis und werden daher vom Boost mitverdoppelt.
  if (isUnderdogTendency) points += 1;
  if (isUnderdogScorer) points += 1;

  if (betIsBoosted) {
    points *= 2;
  }

  return points;
}