import { supabase } from './supabaseClient.js';
import axios from 'axios';
import dotenv from 'dotenv';

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function resetApiCounter() {
  console.log("[Daily-Sync] Setze API-Counter in der Datenbank auf 0 zurück...");
  const { error } = await supabase.from('system_state').update({ count_calls: 0 }).eq('id', 1);
  if (error) throw error; 
}

async function incrementCounterBy(amount) {
  const { data: currentState } = await supabase.from('system_state').select('count_calls').single();
  if (currentState) {
    await supabase.from('system_state').update({ count_calls: currentState.count_calls + amount }).eq('id', 1);
  }
}

/**
 * Holt die Statistiken (Tore) eines Teams. Paginierung wird automatisch aufgelöst.
 */
async function fetchTeamStats(teamIdApi) {
  let page = 1;
  let totalPages = 1;
  let allPlayersStats = [];
  let apiCalls = 0;

  while (page <= totalPages) {
    try {
      const response = await axios.get(`${API_URL}/players`, {
        headers: { 'x-apisports-key': API_KEY },
        params: { team: teamIdApi, league: 10, season: 2026, page: page }
      });
      apiCalls++;

      const responseData = response.data.response;
      if (responseData && responseData.length > 0) {
        allPlayersStats = allPlayersStats.concat(responseData);
      }

      totalPages = response.data.paging.total || 1;
      page++;
      
      await delay(1000); // Rate-Limit Schutz für Paginierung
    } catch (error) {
      console.error(`Fehler beim Abrufen der Statistiken für Team API-ID ${teamIdApi} (Seite ${page}):`, error.message);
      break; 
    }
  }

  return { stats: allPlayersStats, calls: apiCalls };
}

export async function runDailySync() {
  console.log(`[${new Date().toISOString()}] Starte täglichen Mitternachts-Sync (Kader & Statistiken)...`);

  try {
    await resetApiCounter();

    const { data: teams, error: teamsError } = await supabase.from('teams').select('id, api_id, name');
    if (teamsError || !teams) return;

    let totalApiCalls = 0;

    for (const team of teams) {
      if (!team.api_id) continue;
      console.log(`Verarbeite Team: ${team.name}...`);
      
      // --- STUFE 1: KADER & POSITIONEN SICHERSTELLEN ---
      try {
        const squadResponse = await axios.get(`${API_URL}/players/squads`, {
          headers: { 'x-apisports-key': API_KEY },
          params: { team: team.api_id }
        });
        totalApiCalls++;

        const squadData = squadResponse.data.response;
        if (squadData && squadData.length > 0 && squadData[0].players) {
          const uniquePlayersMap = new Map();

          for (const p of squadData[0].players) {
            uniquePlayersMap.set(p.id, {
              api_id: p.id,
              name: p.name,
              position: p.position || null,
              team_id: team.id,
              created_at: new Date().toISOString()
            });
          }

          const playersToInsert = Array.from(uniquePlayersMap.values());

          const { error: upsertError } = await supabase.from('players').upsert(playersToInsert, { onConflict: 'api_id' });
          if (upsertError) console.error(`DB-Fehler bei Kader für ${team.name}:`, upsertError.message);
        }
      } catch (err) {
        console.error(`API-Fehler beim Kader-Abruf für ${team.name}:`, err.message);
      }
      
      await delay(1000);

      // --- STUFE 2: TURNIER-TORE AKTUALISIEREN ---
      // Wir holen alle Spieler-Statistiken. Wenn ein Spieler Tore hat, updaten wir gezielt seine Zeile.
      const { stats, calls } = await fetchTeamStats(team.api_id);
      totalApiCalls += calls;

      if (stats.length > 0) {
        let updateCount = 0;
        for (const p of stats) {
          // Sicheres Auslesen der Tore über Optional Chaining
          const goals = p.statistics?.[0]?.goals?.total || 0;
          
          if (goals > 0) {
            const { error: updateError } = await supabase
              .from('players')
              .update({ tournament_goals: goals })
              .eq('api_id', p.player.id);
            
            if (!updateError) updateCount++;
          }
        }
        if (updateCount > 0) {
           console.log(`✅ ${updateCount} Spieler mit Toren für ${team.name} in der DB aktualisiert.`);
        }
      }
    }

    await incrementCounterBy(totalApiCalls);
    console.log(`[Daily-Sync] Abgeschlossen. ${totalApiCalls} API-Aufrufe registriert.`);

  } catch (err) {
    console.error("Unerwarteter Fehler im Daily-Sync:", err.message);
  }
}