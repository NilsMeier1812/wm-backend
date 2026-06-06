import { supabase } from './supabaseClient.js';
import axios from 'axios';
import { checkApiLimits, incrementApiCounter } from './apiHandler.js'; 

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const BOT_UUID = 'a17b3ca0-c358-4d7a-9046-bd2bc4d522d7';

// ... (Hier bleiben die Hilfsfunktionen normalizeName, levenshteinDistance, calculateAdvancedSimilarity wie zuvor identisch) ...

function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ") 
    .trim()
    .replace(/\s+/g, " "); 
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function calculateAdvancedSimilarity(apiName, dbName) {
  const normApi = normalizeName(apiName);
  const normDb = normalizeName(dbName);

  if (normApi === normDb) return 1.0;

  const apiTokens = normApi.split(' ');
  const dbTokens = normDb.split(' ');

  const apiLastName = apiTokens[apiTokens.length - 1];
  const dbLastName = dbTokens[dbTokens.length - 1];

  const lastNameDist = levenshteinDistance(apiLastName, dbLastName);
  const maxLastNameLen = Math.max(apiLastName.length, dbLastName.length);
  const lastNameSimilarity = (maxLastNameLen - lastNameDist) / maxLastNameLen;

  if (lastNameSimilarity < 0.75) {
    return 0; 
  }

  const apiFirstName = apiTokens[0];
  const dbFirstName = dbTokens[0];

  if (dbFirstName.length === 1 && apiTokens.length > 1) {
    if (apiFirstName.charAt(0) === dbFirstName) {
       return 0.95; 
    } else {
       return 0;
    }
  }

  const dist = levenshteinDistance(normApi, normDb);
  const maxLen = Math.max(normApi.length, normDb.length);
  return (maxLen - dist) / maxLen;
}

export async function placeBotBets() {
  // --- ROBUSTHEITS-CHECK: Existiert der Bot-Nutzer in der aktuellen Umgebung? ---
  const { data: botUser, error: userCheckError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', BOT_UUID)
    .single();

  // Wenn der User nicht existiert oder ein DB-Fehler auftritt, skippe das gesamte Skript
  if (userCheckError || !botUser) {
    console.log(`[Bot] Bot-UUID ${BOT_UUID} nicht in dieser Umgebung gefunden. Bot-Skript wird übersprungen.`);
    return;
  }

  const now = new Date();
  const threshold45m = new Date(now.getTime() + 45 * 60000);
  const threshold15m = new Date(now.getTime() + 15 * 60000);

  const { data: matches, error: matchError } = await supabase
    .from('matches')
    .select('id, api_id, home_team_id, away_team_id, kickoff_time')
    .lte('kickoff_time', threshold45m.toISOString())
    .gte('kickoff_time', threshold15m.toISOString())
    .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

  if (matchError || !matches) return;

  for (const match of matches) {
    const { data: existingBet } = await supabase
      .from('bets')
      .select('id')
      .eq('match_id', match.id)
      .eq('user_id', BOT_UUID)
      .single();

    if (existingBet) continue; 

    const canFetch = await checkApiLimits();
    if (!canFetch) return;

    try {
      const response = await axios.get(`${API_URL}/odds`, {
        headers: { 'x-apisports-key': API_KEY },
        params: { fixture: match.api_id, bookmaker: 8 } 
      });
      await incrementApiCounter();

      const bookmakers = response.data?.response?.[0]?.bookmakers;
      if (!bookmakers || bookmakers.length === 0) continue;

      const betsData = bookmakers[0].bets;
      
      const exactScoreBet = betsData.find(b => b.id === 10);
      let bestScoreStr = null;
      if (exactScoreBet && exactScoreBet.values.length > 0) {
        const lowestOddScore = exactScoreBet.values.reduce((prev, curr) => 
          parseFloat(curr.odd) < parseFloat(prev.odd) ? curr : prev
        );
        bestScoreStr = lowestOddScore.value; 
      }

      if (!bestScoreStr) continue;
      const [home_score, away_score] = bestScoreStr.split(':').map(Number);
      
      const is_goalless = (home_score === 0 && away_score === 0);
      let first_goalscorer_id = null;

      if (!is_goalless) {
        let validPlayers = [];
        const { data: lineups } = await supabase
          .from('match_lineups')
          .select(`player_id, is_starter, players!inner(id, name)`)
          .eq('match_id', match.id)
          .eq('is_starter', true);

        if (lineups && lineups.length > 0) {
          validPlayers = lineups.map(l => ({ id: l.player_id, name: l.players.name }));
        } else {
          const { data: squadPlayers } = await supabase
            .from('players')
            .select('id, name')
            .in('team_id', [match.home_team_id, match.away_team_id]);
          if (squadPlayers) validPlayers = squadPlayers;
        }

        const firstGoalscorerBet = betsData.find(b => b.id === 93);
        
        if (firstGoalscorerBet && firstGoalscorerBet.values.length > 0 && validPlayers.length > 0) {
          const sortedScorers = [...firstGoalscorerBet.values].sort((a, b) => parseFloat(a.odd) - parseFloat(b.odd));

          for (const scorerValue of sortedScorers) {
            const apiName = scorerValue.value;
            if (apiName === 'No Goalscorer') break;

            let bestMatch = null;
            let highestSimilarity = 0;

            for (const dbPlayer of validPlayers) {
              const similarity = calculateAdvancedSimilarity(apiName, dbPlayer.name);
              if (similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = dbPlayer;
              }
            }

            if (bestMatch && highestSimilarity >= 0.85) {
              first_goalscorer_id = bestMatch.id;
              break; 
            }
          }
        }
      }

      const { error: insertError } = await supabase
        .from('bets')
        .insert({
          user_id: BOT_UUID,
          match_id: match.id,
          home_score: home_score,
          away_score: away_score,
          first_goalscorer_id: first_goalscorer_id,
          is_goalless: is_goalless,
          created_at: new Date().toISOString()
        });

      if (insertError) {
        console.error(`[Bot] DB-Fehler beim Insert (Spiel ${match.id}):`, insertError.message);
      }
    } catch (err) {
      console.error(`[Bot] API Fehler für Spiel ${match.api_id}:`, err.message);
    }
  }
}