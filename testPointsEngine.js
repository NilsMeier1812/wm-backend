import { calculatePoints, computeUnderdogFlags } from './pointsEngine.js';

// Strukturierte Testfälle
const testCases = [
  {
    name: "1. Exaktes Ergebnis (ohne Torschütze)",
    params: [2, 1, 2, 1, null, null],
    expected: 3
  },
  {
    name: "2. Exaktes Ergebnis + Richtiger Torschütze",
    params: [2, 1, 2, 1, 99, 99],
    expected: 4
  },
  {
    name: "3. Exaktes Ergebnis + Falscher Torschütze",
    params: [2, 1, 2, 1, 99, 88],
    expected: 3
  },
  {
    name: "4. Korrekte Tordifferenz (Heimsieg)",
    params: [3, 1, 2, 0, null, null],
    expected: 2
  },
  {
    name: "5. Korrekte Tordifferenz (Falsches Unentschieden)",
    params: [1, 1, 0, 0, null, null],
    expected: 2
  },
  {
    name: "6. Korrekte Tendenz (Heimsieg)",
    params: [2, 0, 1, 0, null, null], // Diff ist +2 vs +1 -> beides Heimsieg
    expected: 1
  },
  {
    name: "7. Falscher Tipp (Auswärtssieg vs Heimsieg)",
    params: [0, 2, 1, 0, null, null],
    expected: 0
  },
  {
    name: "8. Falscher Tipp + aber Torschütze richtig geraten",
    params: [0, 2, 1, 0, 99, 99],
    expected: 1
  },
  {
    name: "9. Unvollständige Spieldaten (Edge Case null)",
    params: [null, 2, 1, 0, null, null],
    expected: 0
  },
  {
    name: "10. Typen-Sicherheit (Strings statt Integer aus DB)",
    params: ["2", "1", 2, 1, "99", 99], // API/DB liefert Strings
    expected: 4
  },
  {
    name: "11. Boosted Bet verdoppelt Punkte",
    params: [2, 1, 2, 1, 99, 99, false, false, true],
    expected: 8
  },
  {
    name: "12. Boosted Bet mit null Punkten bleibt null",
    params: [0, 2, 1, 0, 99, 88, false, false, true],
    expected: 0
  },
  // Parameter-Reihenfolge: [..., betIsBoosted, isUnderdogTendency, isUnderdogScorer]
  {
    name: "13. Underdog Tendenz (+1 auf Tendenz-Treffer)",
    params: [2, 0, 1, 0, null, null, false, false, false, true, false],
    expected: 2 // 1 (Tendenz) + 1 (Underdog Tendenz)
  },
  {
    name: "14. Underdog Torschütze (+1 auf exaktes Ergebnis + Schütze)",
    params: [2, 1, 2, 1, 99, 99, false, false, false, false, true],
    expected: 5 // 3 (exakt) + 1 (Schütze) + 1 (Underdog Schütze)
  },
  {
    name: "15. Beide Underdog-Boni zählen vor dem Boost (×2)",
    params: [2, 1, 2, 1, 99, 99, false, false, true, true, true],
    expected: 12 // (3 + 1 + 1 + 1) × 2
  },
  {
    name: "16. Underdog Tendenz wird mit Boost verdoppelt",
    params: [2, 0, 1, 0, null, null, false, false, true, true, false],
    expected: 4 // (1 + 1) × 2
  }
];

// Test-Runner Logik
console.log("Starte strukturierte Punkte-Tests...\n");

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  // Entpackt die Parameter aus dem Array und übergibt sie an die Funktion
  const result = calculatePoints(...test.params);
  
  if (result === test.expected) {
    console.log(`✅ [PASS] ${test.name} -> Erwartet: ${test.expected}, Bekommen: ${result}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${test.name} -> Erwartet: ${test.expected}, Bekommen: ${result}`);
    console.error(`   Parameter: ${JSON.stringify(test.params)}`);
    failed++;
  }
});

// --- Tests für computeUnderdogFlags ---
console.log("\nStarte Underdog-Flag-Tests...\n");

const b = (home, away, scorer = null, goalless = false) => ({
  home_score: home, away_score: away, first_goalscorer_id: scorer, is_goalless: goalless
});

const underdogCases = [
  {
    name: "U1. Einziger korrekter Tipp (Tendenz + Schütze)",
    bets: [b(2, 1, 99), b(1, 1, 88), b(0, 2, 77)],
    target: 0, actual: [2, 1], scorerKey: '99',
    expected: { isUnderdogTendency: true, isUnderdogScorer: true }
  },
  {
    name: "U2. Tendenz geteilt (2× Heimsieg) -> nur Schütze ist Underdog",
    bets: [b(2, 1, 99), b(3, 0, 88), b(0, 1, 77)],
    target: 0, actual: [2, 1], scorerKey: '99',
    expected: { isUnderdogTendency: false, isUnderdogScorer: true }
  },
  {
    name: "U3. Falscher Tipp bekommt keinen Underdog",
    bets: [b(2, 1, 99), b(1, 1, 88), b(0, 2, 77)],
    target: 1, actual: [2, 1], scorerKey: '99',
    expected: { isUnderdogTendency: false, isUnderdogScorer: false }
  },
  {
    name: "U4. 'Kein Tor' zählt als einziger korrekter Schütze",
    bets: [b(0, 0, null, true), b(2, 1, 99), b(0, 1, 77)],
    target: 0, actual: [0, 0], scorerKey: 'goalless',
    expected: { isUnderdogTendency: true, isUnderdogScorer: true }
  }
];

underdogCases.forEach(test => {
  const bet = test.bets[test.target];
  const result = computeUnderdogFlags(bet, test.bets, test.actual[0], test.actual[1], test.scorerKey);
  const ok = result.isUnderdogTendency === test.expected.isUnderdogTendency &&
             result.isUnderdogScorer === test.expected.isUnderdogScorer;
  if (ok) {
    console.log(`✅ [PASS] ${test.name}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${test.name} -> Erwartet: ${JSON.stringify(test.expected)}, Bekommen: ${JSON.stringify(result)}`);
    failed++;
  }
});

console.log("\n--- Testergebnisse ---");
console.log(`${passed} bestanden, ${failed} fehlgeschlagen.`);

// Beendet den Prozess mit Fehlercode, falls ein Test fehlschlägt
if (failed > 0) {
  process.exit(1);
}