import { calculatePoints } from './pointsEngine.js';

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

console.log("\n--- Testergebnisse ---");
console.log(`${passed} bestanden, ${failed} fehlgeschlagen.`);

// Beendet den Prozess mit Fehlercode, falls ein Test fehlschlägt
if (failed > 0) {
  process.exit(1);
}