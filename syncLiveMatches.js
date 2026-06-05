import { fetchFixturesByIds, syncMatchEvents } from './apiHandler.js';
import { calculatePoints } from './pointsEngine.js';
import { supabase } from './supabaseClient.js';
import { sendErrorAlert } from './notifier.js';

const STATUS_GROUPS = {
  NOT_STARTED: ['TBD', 'NS'],
  IN_PLAY: ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'],
  FINISHED: ['FT', 'AET', 'PEN'],
  CANCELED: ['PST', 'CANC', 'ABD', 'AWD', 'WO']
};

export async function syncLiveMatches() {
  const now = new Date();
  const checkThreshold = new Date(now.getTime() + 5 * 60000); 

  const { data: activeDbMatches, error: matchQueryError } = await supabase
    .from('matches')
    .select('id, api_id, status, points_processed, is_goalless')
    .lte('kickoff_time', checkThreshold.toISOString())
    .is('points_processed', false)
    .not('status', 'in', `(${STATUS_GROUPS.CANCELED.map(s => `'${s}'`).join(',')})`);

  if (matchQueryError) {
    await sendErrorAlert('DB Query: activeDbMatches', matchQueryError);
    return;
  }

  if (!activeDbMatches || activeDbMatches.length === 0) return;

  const matchIdsToFetch = activeDbMatches.map(m => m.api_id);
  const apiMatches = await fetchFixturesByIds(matchIdsToFetch);
  
  if (!apiMatches || apiMatches.length === 0) return;

  for (const match of apiMatches) {
    const apiMatchId = match.fixture.id;
    const statusShort = match.fixture.status.short; 
    const dbMatch = activeDbMatches.find(m => m.api_id === apiMatchId);

    if (!dbMatch) continue;

    const homeScoreExclPenalties = match.goals.home ?? 0;
    const awayScoreExclPenalties = match.goals.away ?? 0;
    const homeScoreExtratime = match.score.extratime.home;
    const awayScoreExtratime = match.score.extratime.away;
    const homeScorePenalty = match.score.penalty.home; // NEU
    const awayScorePenalty = match.score.penalty.away; // NEU
    
    try {
      await supabase
        .from('matches')
        .update({
          status: statusShort,
          home_score: homeScoreExclPenalties,
          away_score: awayScoreExclPenalties,
          home_score_extratime: homeScoreExtratime,
          away_score_extratime: awayScoreExtratime,
          home_score_penalty: homeScorePenalty, // NEU
          away_score_penalty: awayScorePenalty, // NEU
          updated_at: new Date().toISOString()
        })
        .eq('api_id', apiMatchId);

      let firstGoalscorerId = null;
      let isGoalless = false;

      // Ereignisse für alle laufenden oder beendeten Spiele abrufen
      if (STATUS_GROUPS.IN_PLAY.includes(statusShort) || STATUS_GROUPS.FINISHED.includes(statusShort)) {
        const fetchedFirstGoalscorerId = await syncMatchEvents(apiMatchId, dbMatch.id);

        if (homeScoreExclPenalties > 0 || awayScoreExclPenalties > 0) {
            if (fetchedFirstGoalscorerId !== null) {
               firstGoalscorerId = fetchedFirstGoalscorerId;
               await supabase
                .from('matches')
                .update({ first_goalscorer_id: firstGoalscorerId, is_goalless: false })
                .eq('api_id', apiMatchId);
            }
        } else if (STATUS_GROUPS.FINISHED.includes(statusShort)) {
            isGoalless = true;
            await supabase
              .from('matches')
              .update({ first_goalscorer_id: null, is_goalless: true })
              .eq('api_id', apiMatchId);
        }
      }

      if (STATUS_GROUPS.FINISHED.includes(statusShort)) {
        console.log(`[Sync] Spiel ${apiMatchId} beendet (${statusShort}). Starte Punkteauswertung...`);
        
        const { data: bets, error: betsError } = await supabase
          .from('bets')
          .select('*')
          .eq('match_id', dbMatch.id);

        if (betsError) {
          await sendErrorAlert(`DB Query: Bets für Spiel ${apiMatchId}`, betsError);
          continue;
        }
        
        if (bets && bets.length > 0) {
          for (const bet of bets) {
            const points = calculatePoints(
              homeScoreExclPenalties, 
              awayScoreExclPenalties, 
              bet.home_score, 
              bet.away_score,
              firstGoalscorerId,
              bet.first_goalscorer_id,
              isGoalless,
              bet.is_goalless,
              bet.is_boosted
            );

            await supabase
              .from('bets')
              .update({ points_awarded: points })
              .eq('id', bet.id);
          }
        }

        await supabase
          .from('matches')
          .update({ points_processed: true })
          .eq('api_id', apiMatchId);

        console.log(`[Sync] Punkte für Spiel ${apiMatchId} finalisiert.`);
      }

    } catch (err) {
      console.error(`Fehler bei der Verarbeitung von Spiel ${apiMatchId}:`, err.message);
      await sendErrorAlert(`SyncLiveMatches: Spiel ${apiMatchId}`, err);
    }
  }
}
