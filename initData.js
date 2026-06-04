import { supabase } from './supabaseClient.js';
import axios from 'axios';
import dotenv from 'dotenv';

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const WORLD_CUP_LEAGUE_ID = 1;
const SEASON = 2026; // Für den Testlauf auf 2022 gesetzt

// Hilfsfunktion für Upsert (verhindert Überlastung der API/DB bei Bulk-Inserts)
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initializeData() {
  console.log("Starte initialen Daten-Import...");

  try {
    // 1. TEAMS ABRUFEN
    console.log("Rufe Teams ab...");
    const teamsResponse = await axios.get(`${API_URL}/teams`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { league: WORLD_CUP_LEAGUE_ID, season: SEASON }
    });

    const teams = teamsResponse.data.response;
    if (teams && teams.length > 0) {
      const teamsToInsert = teams.map(t => ({
        api_id: t.team.id,
        name: t.team.name,
        flag_url: t.team.logo,
        updated_at: new Date().toISOString() // Zwingend erforderlich für die Datenbank
      }));

      const { error: teamErr } = await supabase.from('teams').upsert(teamsToInsert, { onConflict: 'api_id' });
      if (teamErr) console.error("Fehler beim Speichern der Teams:", teamErr);
      else console.log(`✅ ${teams.length} Teams erfolgreich synchronisiert.`);
    }

    await delay(2000);

    // 2. SPIELE (FIXTURES) ABRUFEN
    console.log("Rufe Spielplan ab...");
    const fixturesResponse = await axios.get(`${API_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { league: WORLD_CUP_LEAGUE_ID, season: SEASON }
    });

    const fixtures = fixturesResponse.data.response;
    if (fixtures && fixtures.length > 0) {
      
      const { data: dbTeams } = await supabase.from('teams').select('id, api_id');
      const teamMap = {};
      if (dbTeams) {
          dbTeams.forEach(t => teamMap[t.api_id] = t.id);
      }

      const matchesToInsert = fixtures.map(f => ({
        api_id: f.fixture.id,
        home_team_id: teamMap[f.teams.home.id] || null,
        away_team_id: teamMap[f.teams.away.id] || null,
        kickoff_time: f.fixture.date, 
        status: f.fixture.status.short, 
        phase: f.league.round,
        updated_at: new Date().toISOString() // Der tiefgründige Fix für den Fehler 23502
      }));

      const { error: matchErr } = await supabase.from('matches').upsert(matchesToInsert, { onConflict: 'api_id' });
      if (matchErr) console.error("Fehler beim Speichern des Spielplans:", matchErr);
      else console.log(`✅ ${fixtures.length} Spiele erfolgreich synchronisiert.`);
    }

    console.log("Initialisierung abgeschlossen.");
    process.exit(0);

  } catch (error) {
    console.error("Kritischer Fehler bei der Initialisierung:", error.message);
    process.exit(1);
  }
}

initializeData();