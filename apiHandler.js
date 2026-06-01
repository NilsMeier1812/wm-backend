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
export async function fetchFirstGoalscorer(apiMatchId) {
  const canFetch = await checkApiLimits();
  if (!canFetch) return null;

  try {
    const response = await axios.get(`${API_URL}/fixtures/events`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { fixture: apiMatchId, type: 'Goal' }
    });

    await incrementApiCounter();

    const events = response.data?.response;
    if (!events || !Array.isArray(events) || events.length === 0) return null;

    const validGoals = events.filter(event => {
      if (event.type !== 'Goal' || !event.detail) return false;
      const detail = event.detail.toLowerCase();
      // Annullierte Tore und verschossene Elfmeter ignorieren.
      // Eigentore werden absichtlich NICHT herausgefiltert.
      return !detail.includes('cancelled') && 
             !detail.includes('missed');
    });

    if (validGoals.length === 0) return null;

    // Zeitlich sortieren, um wirklich das erste Tor zu finden
    validGoals.sort((a, b) => {
      const timeA = a.time.elapsed + (a.time.extra || 0);
      const timeB = b.time.elapsed + (b.time.extra || 0);
      return timeA - timeB;
    });

    const apiPlayerId = validGoals[0].player ? validGoals[0].player.id : null;
    
    if (!apiPlayerId) return null;

    // Interne Supabase-ID des Spielers auflösen
    const { data: player, error } = await supabase
      .from('players')
      .select('id')
      .eq('api_id', apiPlayerId)
      .single();

    if (error || !player) {
      console.warn(`Spieler mit API-ID ${apiPlayerId} nicht in der internen DB gefunden (Spiel ${apiMatchId}).`);
      return null;
    }

    return player.id;
    
  } catch (error) {
    console.error(`Fehler bei Event-Abfrage für Spiel ${apiMatchId}:`, error.message);
    return null; 
  }
}