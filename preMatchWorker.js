import { supabase } from './supabaseClient.js';
import { checkApiLimits } from './apiHandler.js';
import { sendErrorAlert } from './notifier.js';
import { Resend } from 'resend';
import axios from 'axios';
import dotenv from 'dotenv';

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function fetchLineupsForUpcomingMatches() {
  const now = new Date();
  const threshold4h = new Date(now.getTime() + 4 * 60 * 60000 + 5 * 60000); 

  const { data: upcomingMatches, error: dbError } = await supabase
    .from('matches')
    // Auch hier den Join einbauen
    .select(`
      id, 
      api_id, 
      kickoff_time, 
      sent_reminders,
      home:teams!home_team_id(name),
      away:teams!away_team_id(name)
    `)
    .lte('kickoff_time', threshold4h.toISOString())
    .gte('kickoff_time', now.toISOString())
    .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

  if (dbError) {
    console.error("Fehler beim Abfragen kommender Spiele (Lineup/Reminder-Check):", dbError.message);
    await sendErrorAlert('PreMatchWorker: Fetch Matches', dbError);
    return;
  }

  if (!upcomingMatches || upcomingMatches.length === 0) return;

  // --- TEIL 1: 2H REMINDER ---
  const triggerMatch = upcomingMatches.find(match => {
    const hoursUntil = (new Date(match.kickoff_time) - now) / (1000 * 60 * 60);
    const sent = match.sent_reminders || [];
    return hoursUntil <= 2 && hoursUntil > 0 && !sent.includes('2h');
  });

  if (triggerMatch) {
    const matchesToRemind = upcomingMatches.filter(m => !(m.sent_reminders || []).includes('2h'));
    
    if (matchesToRemind.length > 0) {
      try {
        await sendBundledReminders(matchesToRemind, 'In Kürze startende Spiele (2h-Reminder)');
        
        for (const m of matchesToRemind) {
          const updatedReminders = [...(m.sent_reminders || []), '2h'];
          await supabase.from('matches').update({ sent_reminders: updatedReminders }).eq('id', m.id);
        }
      } catch (error) {
         console.error("Fehler beim 2h-Bundle-Reminder:", error);
         await sendErrorAlert('Reminder-System: Bundle 2h', error);
      }
    }
  }

  // --- TEIL 2: LINEUPS (1H) ---
  for (const match of upcomingMatches) {
    const kickoffTime = new Date(match.kickoff_time);
    const hoursUntilMatch = (kickoffTime - now) / (1000 * 60 * 60);

    if (hoursUntilMatch > 1.2) {
      continue; 
    }

    const { count, error: countError } = await supabase
      .from('match_lineups')
      .select('*', { count: 'exact', head: true })
      .eq('match_id', match.id);

    if (countError) {
      await sendErrorAlert(`PreMatchWorker: Lineup Count ${match.id}`, countError);
      continue;
    }

    if (count > 0) continue; 

    console.log(`[Pre-Match] Versuche Aufstellung für Spiel ${match.api_id} abzurufen...`);
    const canFetch = await checkApiLimits();
    if (!canFetch) return; 

    try {
      const apiResponse = await axios.get(`${API_URL}/fixtures/lineups`, {
        headers: { 'x-apisports-key': API_KEY },
        params: { fixture: match.api_id }
      });

      const data = apiResponse.data;
      const apiErrors = data?.errors;
      const hasErrors = Array.isArray(apiErrors) ? apiErrors.length > 0 : (apiErrors && Object.keys(apiErrors).length > 0);
      
      if (hasErrors) {
        console.error(`[Pre-Match] API meldet Fehler für Spiel ${match.api_id}:`, apiErrors);
        await sendErrorAlert(`PreMatchWorker: API Error Payload ${match.api_id}`, new Error(JSON.stringify(apiErrors)));
        continue;
      }

      const lineups = data?.response;
      if (!Array.isArray(lineups) || lineups.length === 0) {
        console.log(`[Pre-Match] Aufstellung für ${match.api_id} noch nicht verfügbar.`);
        continue;
      }

      const teamApiIds = lineups.map(t => t.team?.id).filter(id => id != null);
      if (teamApiIds.length === 0) continue;

      const { data: dbTeams, error: teamsError } = await supabase
        .from('teams')
        .select('id, api_id')
        .in('api_id', teamApiIds);

      if (teamsError) {
        await sendErrorAlert(`PreMatchWorker: Fetch Teams ${match.api_id}`, teamsError);
        continue;
      }

      const teamIdMap = {};
      for (const team of dbTeams) teamIdMap[team.api_id] = team.id;

      const playersToUpsert = [];
      const lineupDefinitions = []; 

      for (const teamLineup of lineups) {
        const teamApiId = teamLineup.team?.id;
        const internalTeamId = teamIdMap[teamApiId];
        if (!internalTeamId) continue; 

        if (Array.isArray(teamLineup?.startXI)) {
          for (const item of teamLineup.startXI) {
            if (item?.player?.id) {
              playersToUpsert.push({ api_id: item.player.id, team_id: internalTeamId, name: item.player.name, position: item.player.pos || null });
              lineupDefinitions.push({ api_id: item.player.id, is_starter: true, status: 'starter' });
            }
          }
        }

        if (Array.isArray(teamLineup?.substitutes)) {
          for (const item of teamLineup.substitutes) {
            if (item?.player?.id) {
              playersToUpsert.push({ api_id: item.player.id, team_id: internalTeamId, name: item.player.name, position: item.player.pos || null });
              lineupDefinitions.push({ api_id: item.player.id, is_starter: false, status: 'substitute' });
            }
          }
        }
      }

      if (playersToUpsert.length === 0) continue;

      const { data: upsertedPlayers, error: upsertError } = await supabase
        .from('players')
        .upsert(playersToUpsert, { onConflict: 'api_id' })
        .select('id, api_id');

      if (upsertError) {
         await sendErrorAlert(`PreMatchWorker: Player Upsert Error`, upsertError);
         continue; 
      }

      const playerIdMap = {};
      for (const p of upsertedPlayers) playerIdMap[p.api_id] = p.id;

      const insertLineupData = [];
      for (const def of lineupDefinitions) {
         if (playerIdMap[def.api_id]) {
           insertLineupData.push({ match_id: match.id, player_id: playerIdMap[def.api_id], is_starter: def.is_starter, status: def.status });
         }
      }

      if (insertLineupData.length > 0) {
        const { error: insertError } = await supabase.from('match_lineups').insert(insertLineupData);
        if (insertError) await sendErrorAlert(`PreMatchWorker: Insert Lineup ${match.id}`, insertError);
      }
    } catch (err) {
      await sendErrorAlert(`PreMatchWorker: API Lineup ${match.api_id}`, err);
    }
  }
}

async function sendBundledReminders(matches, contextTitle) {
  console.log(`[Reminder] Bündele ${matches.length} Spiele für Reminder...`);
  const matchIds = matches.map(m => m.id);

  const { data: bets, error: betsError } = await supabase
    .from('bets')
    .select('user_id, match_id')
    .in('match_id', matchIds)
    .not('home_score', 'is', null);

  if (betsError) throw betsError;

  const { data: users, error: usersError } = await supabase
    .from('profiles')
    .select('id, email')
    .eq('missing_tip_reminder', true);

  if (usersError || !users) throw usersError;

  const emailBatch = [];

  for (const user of users) {
    const userBets = bets.filter(b => b.user_id === user.id).map(b => b.match_id);
    const missingMatches = matches.filter(m => !userBets.includes(m.id));

    if (missingMatches.length > 0) {
      const matchHtmlList = missingMatches.map(m => {
        const time = new Date(m.kickoff_time).toLocaleTimeString('de-DE', { 
          timeZone: 'Europe/Berlin', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        
        // Team-Namen extrahieren
        const homeName = m.home?.name || 'Unbekannt';
        const awayName = m.away?.name || 'Unbekannt';
        
        return `<li><strong>${time} Uhr:</strong> ${homeName} vs. ${awayName}</li>`;
      }).join('');

      emailBatch.push({
        from: `WM Tippspiel <${process.env.ALERT_FROM_EMAIL}>`,
        to: [user.email],
        subject: `⏳ Tipp nicht vergessen! (${missingMatches.length} anstehende Spiele)`,
        html: `
          <h2>Deine Tipps fehlen noch!</h2>
          <p>Servus,</p>
          <p>${contextTitle}. Für folgende Spiele hast du noch keinen Tipp abgegeben:</p>
          <ul>${matchHtmlList}</ul>
          <p>Geh jetzt auf die Website und trage deine Tipps ein, um keine Punkte zu verpassen!</p>
          <br><p>Viel Erfolg,<br>Nils</p>
        `
      });
    }
  }

  if (emailBatch.length === 0) return;

  const chunkSize = 100;
  for (let i = 0; i < emailBatch.length; i += chunkSize) {
    const chunk = emailBatch.slice(i, i + chunkSize);
    const { error: resendError } = await resend.batch.send(chunk);
    if (resendError) throw new Error(`Resend Batch-Fehler: ${JSON.stringify(resendError)}`);
  }
}