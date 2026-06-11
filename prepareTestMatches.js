import { supabase } from './supabaseClient.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function prepareTest() {
  console.log("Starte Vorbereitung für den Live-Test (Hardcoded auf 2026-06-02)...");

  try {
    // 1. Hardcoded Datum
    const dateString = '2026-06-10';
    
    console.log(`Suche Freundschaftsspiele (League 10, Season 2026) für ${dateString}...`);

    // 2. Spiele für das fixierte Datum abrufen
    const fixturesResponse = await axios.get(`${API_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { 
        date: dateString,
        league: 10,
        season: 2026
      }
    });

    const allFixtures = fixturesResponse.data.response;
    if (!allFixtures || allFixtures.length === 0) {
      console.error("Keine Freundschaftsspiele für dieses Datum gefunden.");
      process.exit(1);
    }

    // Wir nehmen ALLE Spiele, die noch nicht gestartet sind (NS)
    // Beendete Spiele (FT) werden ignoriert, da sie für einen Live-Test unbrauchbar sind.
    const testMatches = allFixtures.filter(f => f.fixture.status.short === 'NS');

    if (testMatches.length === 0) {
      console.error("Keine ungestarteten Freundschaftsspiele (Status 'NS') gefunden.");
      process.exit(1);
    }

    console.log(`${testMatches.length} ungestartete Spiele gefunden. Bereite Daten vor...`);

    // 3. Teams extrahieren und in die DB laden
    const teamsMap = new Map();
    testMatches.forEach(f => {
      teamsMap.set(f.teams.home.id, { api_id: f.teams.home.id, name: f.teams.home.name, flag_url: f.teams.home.logo, updated_at: new Date().toISOString() });
      teamsMap.set(f.teams.away.id, { api_id: f.teams.away.id, name: f.teams.away.name, flag_url: f.teams.away.logo, updated_at: new Date().toISOString() });
    });

    const teamsToInsert = Array.from(teamsMap.values());
    console.log(`Speichere ${teamsToInsert.length} Teams...`);
    
    const { error: teamErr } = await supabase.from('teams').upsert(teamsToInsert, { onConflict: 'api_id' });
    if (teamErr) throw new Error(`Fehler bei Teams: ${teamErr.message}`);

    await delay(1500);

    // 4. Interne Supabase-IDs der Teams abrufen für die Relationen
    const { data: dbTeams } = await supabase.from('teams').select('id, api_id');
    const dbTeamMap = {};
    if (dbTeams) dbTeams.forEach(t => dbTeamMap[t.api_id] = t.id);

    // 5. Spiele in die DB laden
    console.log(`Speichere ${testMatches.length} Test-Spiele...`);
    const matchesToInsert = testMatches.map(f => ({
      api_id: f.fixture.id,
      home_team_id: dbTeamMap[f.teams.home.id],
      away_team_id: dbTeamMap[f.teams.away.id],
      kickoff_time: f.fixture.date,
      status: f.fixture.status.short,
      phase: 'Friendly Test',
      updated_at: new Date().toISOString()
    }));

    const { error: matchErr } = await supabase.from('matches').upsert(matchesToInsert, { onConflict: 'api_id' });
    if (matchErr) throw new Error(`Fehler bei Spielen: ${matchErr.message}`);

    await delay(1500);

    // 6. Kader (Players) für diese Teams ziehen
    console.log("Ziehe Kader für alle beteiligten Teams (dies kann aufgrund von Rate-Limits dauern)...");
    for (const team of teamsToInsert) {
      console.log(`Lade Spieler für ${team.name}...`);
      try {
        const squadResponse = await axios.get(`${API_URL}/players/squads`, {
          headers: { 'x-apisports-key': API_KEY },
          params: { team: team.api_id }
        });

        const squadData = squadResponse.data.response;
        if (squadData && squadData.length > 0 && squadData[0].players) {
          const playersToInsert = squadData[0].players.map(p => ({
            api_id: p.id,
            name: p.name,
            position: p.position || null,
            team_id: dbTeamMap[team.api_id],
            created_at: new Date().toISOString()
          }));

          const { error: playerErr } = await supabase.from('players').upsert(playersToInsert, { onConflict: 'api_id' });
          if (playerErr) console.error(`DB-Fehler bei Spielern für ${team.name}:`, playerErr.message);
        } else {
            console.warn(`Keine Kaderdaten für ${team.name} von der API erhalten.`);
        }
      } catch (err) {
        console.error(`API-Fehler beim Kader-Abruf für ${team.name}:`, err.message);
      }
      await delay(1500); // Rate-Limit Schutz
    }

    console.log("\n✅ Test-Setup erfolgreich abgeschlossen.");
    console.log("Du kannst nun im Frontend Tipps für diese Spiele abgeben.");
    process.exit(0);

  } catch (error) {
    console.error("\n❌ Kritischer Fehler beim Test-Setup:", error.message);
    process.exit(1);
  }
}

prepareTest();