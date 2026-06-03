import axios from 'axios';
import { supabase } from './supabaseClient.js';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const SAFE_MODE_THRESHOLD = 6000;

if (!API_KEY) {
  console.error("Kritischer Architekturfehler: API_FOOTBALL_KEY fehlt.");
  process.exit(1);
}

export async function checkApiLimits() {
  const { data, error } = await supabase.from('system_state').select('count_calls').single();
  if (error) return false;
  if (data && data.count_calls >= SAFE_MODE_THRESHOLD) {
    console.warn(`SAFE MODE AKTIV: API-Limit von ${SAFE_MODE_THRESHOLD} erreicht.`);
    return false;
  }
  return true;
}

async function incrementApiCounter() {
  const { data: currentState } = await supabase.from('system_state').select('count_calls').single();
  if (currentState) {
    await supabase.from('system_state').update({ count_calls: currentState.count_calls + 1 }).eq('id', 1);
  }
}

/**
 * Holt gezielt nur Spiele basierend auf ihren IDs.
 */
export async function fetchFixturesByIds(apiMatchIds) {
  if (!apiMatchIds || apiMatchIds.length === 0) return [];
  const canFetch = await checkApiLimits();
  if (!canFetch) return null;

  try {
    const idsString = apiMatchIds.slice(0, 20).join('-'); 

    const response = await axios.get(`${API_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { ids: idsString }
    });

    await incrementApiCounter();
    
    if (response.data?.errors && Object.keys(response.data.errors).length > 0) {
       console.error("API meldet Fehler:", response.data.errors);
       return null;
    }

    return response.data.response;
  } catch (error) {
    console.error("Verbindungsfehler zur API-Football (fetchFixturesByIds):", error.message);
    return null;
  }
}

/**
 * Ermittelt den ersten Torschützen.
 * Übersetzt die API-ID direkt in die interne Datenbank-ID.
 * Eigentore werden hier explizit mitgewertet.
 */
export async function syncMatchEvents(apiMatchId, dbMatchId) {
  const canFetch = await checkApiLimits();
  if (!canFetch) return null;

  try {
    const response = await axios.get(`${API_URL}/fixtures/events`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { fixture: apiMatchId }
    });

    await incrementApiCounter();

    const events = response.data?.response;
    if (!events || !Array.isArray(events)) return null;

    // IDs sammeln, um N+1-Abfragen zu verhindern
    const apiPlayerIds = [];
    const apiTeamIds = [];

    events.forEach(e => {
      if (e.player?.id) apiPlayerIds.push(e.player.id);
      if (e.team?.id) apiTeamIds.push(e.team.id);
    });

    const uniqueApiPlayerIds = [...new Set(apiPlayerIds)];
    const uniqueApiTeamIds = [...new Set(apiTeamIds)];

    let playerMap = {};
    let teamMap = {};

    if (uniqueApiPlayerIds.length > 0) {
      const { data: players } = await supabase
        .from('players')
        .select('id, api_id')
        .in('api_id', uniqueApiPlayerIds);
      if (players) {
        playerMap = Object.fromEntries(players.map(p => [p.api_id, p.id]));
      }
    }

    if (uniqueApiTeamIds.length > 0) {
      const { data: teams } = await supabase
        .from('teams')
        .select('id, api_id')
        .in('api_id', uniqueApiTeamIds);
      if (teams) {
        teamMap = Object.fromEntries(teams.map(t => [t.api_id, t.id]));
      }
    }

    const dbEvents = [];
    let firstGoalscorerId = null;
    let earliestGoalTime = Infinity;

    for (const e of events) {
      const apiPlayerId = e.player?.id;
      const apiTeamId = e.team?.id;

      const dbPlayerId = playerMap[apiPlayerId] || null;
      const dbTeamId = teamMap[apiTeamId] || null;

      // Da player_id im Schema der match_events-Tabelle genutzt wird,
      // müssen Ereignisse ohne zugeordneten Spieler ignoriert werden.
      if (!dbPlayerId) continue;

      const detail = e.detail || '';
      const detailLower = detail.toLowerCase();

      let finalEventType = e.type;
      
      // Kritische Bereinigung: Verhindert falsche Zählungen im View
      if (e.type === 'Goal' && (detailLower.includes('missed') || detailLower.includes('cancelled'))) {
        finalEventType = 'Goal_Invalid';
      }

      dbEvents.push({
        match_id: dbMatchId,
        team_id: dbTeamId,
        player_id: dbPlayerId,
        event_type: finalEventType,
        event_detail: e.detail || null,
        time_minute: e.time.elapsed,
        time_extra: e.time.extra || null
      });

      // Ersten Torschützen ermitteln (Eigentore absichtlich eingeschlossen)
      if (e.type === 'Goal' && !detailLower.includes('missed') && !detailLower.includes('cancelled')) {
        const absoluteTime = e.time.elapsed + (e.time.extra || 0);
        if (absoluteTime < earliestGoalTime) {
          earliestGoalTime = absoluteTime;
          firstGoalscorerId = dbPlayerId;
        }
      }
    }

    // Löschen alter Einträge für dieses Spiel, um Duplikate bei Live-Updates zu vermeiden
    await supabase.from('match_events').delete().eq('match_id', dbMatchId);

    if (dbEvents.length > 0) {
      const { error: insertError } = await supabase.from('match_events').insert(dbEvents);
      if (insertError) {
        console.error(`Fehler beim Schreiben der match_events für Spiel ${dbMatchId}:`, insertError.message);
      }
    }

  return firstGoalscorerId;
  } catch (error) {
    console.error(`Fehler bei Event-Verarbeitung für Spiel ${apiMatchId}:`, error.message);
    return null;
  }
}