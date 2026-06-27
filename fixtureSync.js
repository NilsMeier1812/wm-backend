import axios from 'axios';
import { supabase } from './supabaseClient.js';
import { checkApiLimits, incrementApiCounter } from './apiHandler.js';
import { sendErrorAlert } from './notifier.js';

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const WORLD_CUP_LEAGUE_ID = 1;
const SEASON = 2026;

// Status, deren Spiele bereits final ausgewertet sind. Diese fassen wir beim
// Schedule-Sync nicht mehr an, damit Ergebnisse/Punkte nicht überschrieben werden.
const FINISHED_STATUS = ['FT', 'AET', 'PEN'];

/**
 * Lädt den kompletten Spielplan der WM von API-Football und nimmt neue Spiele
 * (z.B. Round of 32, sobald die Paarungen feststehen) in die Datenbank auf.
 *
 * Wichtig: home_team_id / away_team_id sind NOT NULL + Foreign Key. Ein
 * K.o.-Spiel kann daher erst eingefügt werden, wenn BEIDE Teams feststehen.
 * Spiele mit noch unbekannten Teams (z.B. "Sieger Gruppe A") werden übersprungen
 * und beim nächsten Lauf erneut geprüft – so erscheinen sie automatisch, sobald
 * die Paarung feststeht.
 *
 * @returns {Promise<number>} Anzahl der neu hinzugefügten Spiele.
 */
export async function syncFixtures() {
  const canFetch = await checkApiLimits();
  if (!canFetch) {
    console.warn('[Fixture-Sync] Übersprungen: API-Limit (Safe Mode) erreicht.');
    return 0;
  }

  let fixtures;
  try {
    const response = await axios.get(`${API_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { league: WORLD_CUP_LEAGUE_ID, season: SEASON }
    });
    await incrementApiCounter();

    if (response.data?.errors && Object.keys(response.data.errors).length > 0) {
      console.error('[Fixture-Sync] API meldet Fehler:', response.data.errors);
      return 0;
    }
    fixtures = response.data?.response;
  } catch (error) {
    console.error('[Fixture-Sync] Verbindungsfehler zur API-Football:', error.message);
    await sendErrorAlert('Fixture-Sync: API Fetch', error);
    return 0;
  }

  if (!fixtures || fixtures.length === 0) {
    console.log('[Fixture-Sync] Keine Spiele von der API erhalten.');
    return 0;
  }

  // Mapping API-Team-ID -> interne Team-ID
  const { data: dbTeams, error: teamsError } = await supabase.from('teams').select('id, api_id');
  if (teamsError || !dbTeams) {
    await sendErrorAlert('Fixture-Sync: Teams laden', teamsError || new Error('Keine Teams'));
    return 0;
  }
  const teamMap = {};
  dbTeams.forEach(t => { teamMap[t.api_id] = t.id; });

  // Bereits bekannte Spiele (api_id -> { status }) ermitteln
  const { data: existing, error: existingError } = await supabase
    .from('matches')
    .select('api_id, status, points_processed');
  if (existingError) {
    await sendErrorAlert('Fixture-Sync: bestehende Spiele laden', existingError);
    return 0;
  }
  const existingMap = new Map((existing || []).map(m => [m.api_id, m]));

  const nowIso = new Date().toISOString();
  const matchesToInsert = [];
  const matchesToUpdate = [];
  let skippedUndetermined = 0;

  for (const f of fixtures) {
    const homeId = teamMap[f.teams?.home?.id];
    const awayId = teamMap[f.teams?.away?.id];

    // Beide Teams müssen feststehen (NOT NULL + FK). Sonst später erneut versuchen.
    if (!homeId || !awayId) {
      skippedUndetermined++;
      continue;
    }

    const apiId = f.fixture.id;
    const known = existingMap.get(apiId);

    if (!known) {
      // Neues Spiel -> komplett anlegen
      matchesToInsert.push({
        api_id: apiId,
        home_team_id: homeId,
        away_team_id: awayId,
        kickoff_time: f.fixture.date,
        status: f.fixture.status.short,
        phase: f.league.round,
        updated_at: nowIso
      });
    } else if (!FINISHED_STATUS.includes(known.status) && !known.points_processed) {
      // Bestehendes, noch nicht abgeschlossenes Spiel: nur Stammdaten
      // (Teams, Anstoßzeit, Phase) aktualisieren. Status & Ergebnis bleiben
      // dem Live-Sync überlassen, damit nichts überschrieben wird.
      matchesToUpdate.push({
        api_id: apiId,
        home_team_id: homeId,
        away_team_id: awayId,
        kickoff_time: f.fixture.date,
        phase: f.league.round
      });
    }
  }

  let insertedCount = 0;

  if (matchesToInsert.length > 0) {
    const { error: insertError } = await supabase
      .from('matches')
      .upsert(matchesToInsert, { onConflict: 'api_id' });
    if (insertError) {
      await sendErrorAlert('Fixture-Sync: Insert neue Spiele', insertError);
    } else {
      insertedCount = matchesToInsert.length;
      const phases = [...new Set(matchesToInsert.map(m => m.phase))].join(', ');
      console.log(`[Fixture-Sync] ✅ ${insertedCount} neue Spiele aufgenommen (Phasen: ${phases}).`);
    }
  }

  // Stammdaten bestehender Spiele aktualisieren (einzeln, damit NOT-NULL-Spalten
  // wie status nicht angefasst werden müssen).
  for (const m of matchesToUpdate) {
    const { error: updateError } = await supabase
      .from('matches')
      .update({
        home_team_id: m.home_team_id,
        away_team_id: m.away_team_id,
        kickoff_time: m.kickoff_time,
        phase: m.phase,
        updated_at: nowIso
      })
      .eq('api_id', m.api_id);
    if (updateError) {
      console.error(`[Fixture-Sync] Fehler beim Update von Spiel ${m.api_id}:`, updateError.message);
    }
  }

  console.log(
    `[Fixture-Sync] Abgeschlossen. Neu: ${insertedCount}, aktualisiert: ${matchesToUpdate.length}, ` +
    `noch ohne feste Paarung übersprungen: ${skippedUndetermined}.`
  );

  return insertedCount;
}
