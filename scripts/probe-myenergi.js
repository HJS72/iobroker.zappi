"use strict";

const { DigestClient } = require("../lib/digestClient");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log("Usage:");
  console.log(
    "  node scripts/probe-myenergi.js --hubSerial <serial> --apiKey <key> [--zappiSerial <serial>] [--testWrite]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --hubSerial    Hub serial number (Digest username)");
  console.log("  --apiKey       myenergi API key (Digest password)");
  console.log("  --zappiSerial  Optional zappi serial; auto-detected if omitted");
  console.log("  --testWrite    Execute safe write checks (same mode and same mgl)");
  console.log("  --testCurrentCandidates  Test known but unverified current-limit endpoint candidates");
  console.log("  --testAmps     Target amps for current-candidate tests (default: 10)");
  console.log("  --help         Show this help");
}

async function getJson(client, path) {
  const text = await client.get(path);
  return JSON.parse(text || "{}");
}

function findZappis(statusPayload) {
  if (!Array.isArray(statusPayload)) {
    return [];
  }

  const result = [];
  for (const group of statusPayload) {
    if (!group || !Array.isArray(group.zappi)) {
      continue;
    }
    for (const zappi of group.zappi) {
      if (zappi && zappi.sno != null) {
        result.push(zappi);
      }
    }
  }
  return result;
}

function looksLikeSuccessResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "status")) {
    return Number(payload.status) === 0;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "statustext")) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "mgl")) {
    return true;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const hubSerial = String(args.hubSerial || "").trim();
  const apiKey = String(args.apiKey || "").trim();
  if (!hubSerial || !apiKey) {
    printHelp();
    throw new Error("Missing --hubSerial or --apiKey");
  }

  const client = new DigestClient("https://director.myenergi.net", hubSerial, apiKey);

  console.log("[1/4] Reading /cgi-jstatus-* ...");
  const statusPayload = await getJson(client, "/cgi-jstatus-*");
  const zappis = findZappis(statusPayload);
  if (zappis.length === 0) {
    throw new Error("No zappi devices found in status payload");
  }

  const requestedSerial = args.zappiSerial ? String(args.zappiSerial).trim() : "";
  const zappi = requestedSerial
    ? zappis.find((item) => String(item.sno) === requestedSerial)
    : zappis[0];

  if (!zappi) {
    throw new Error(`Zappi serial ${requestedSerial} not found. Available: ${zappis.map((z) => z.sno).join(", ")}`);
  }

  const zappiSerial = String(zappi.sno);
  const modeCode = Number(zappi.zmo || 0);
  const mgl = Number(zappi.mgl || 100);

  console.log(`[2/4] Active zappi serial: ${zappiSerial}`);
  console.log(`[2/4] Current mode code (zmo): ${modeCode}`);
  console.log(`[2/4] Current min green level (mgl): ${mgl}`);

  const knownEndpoints = {
    fast: `/cgi-zappi-mode-Z${zappiSerial}-1-0-0-0000`,
    eco: `/cgi-zappi-mode-Z${zappiSerial}-2-0-0-0000`,
    ecoPlus: `/cgi-zappi-mode-Z${zappiSerial}-3-0-0-0000`,
    stop: `/cgi-zappi-mode-Z${zappiSerial}-4-0-0-0000`,
    stopBoost: `/cgi-zappi-mode-Z${zappiSerial}-0-2-0-0000`,
    setMinGreen: `/cgi-set-min-green-Z${zappiSerial}-${mgl}`
  };

  console.log("[3/4] Known and widely used zappi cloud endpoints:");
  Object.entries(knownEndpoints).forEach(([name, endpoint]) => {
    console.log(`  - ${name}: ${endpoint}`);
  });

  if (args.testCurrentCandidates) {
    const testAmps = Math.max(6, Math.min(32, Math.round(Number(args.testAmps || 10))));
    const candidateTemplates = [
      "/cgi-set-device-limit-Z{serial}-{amps}",
      "/cgi-set-current-limit-Z{serial}-{amps}",
      "/cgi-set-max-current-Z{serial}-{amps}",
      "/cgi-set-charge-rate-Z{serial}-{amps}",
      "/cgi-zappi-set-current-Z{serial}-{amps}"
    ];

    console.log(`[3/4] Testing current-limit candidates with ${testAmps}A (may change charging behavior) ...`);
    for (const template of candidateTemplates) {
      const path = template
        .replaceAll("{serial}", zappiSerial)
        .replaceAll("{amps}", String(testAmps));
      try {
        const result = await getJson(client, path);
        const success = looksLikeSuccessResponse(result);
        console.log(`  - ${path}`);
        console.log(`    response: ${JSON.stringify(result)}`);
        console.log(`    interpretedSuccess: ${success}`);
      } catch (error) {
        console.log(`  - ${path}`);
        console.log(`    error: ${error.message}`);
      }
    }
  }

  if (!args.testWrite) {
    console.log("[4/4] Dry-run complete (no write request executed).");
    console.log("      Add --testWrite to run safe write checks.");
    return;
  }

  console.log("[4/4] Running safe write checks ...");

  const modeToUse = modeCode >= 1 && modeCode <= 4 ? modeCode : 4;
  const keepModePath = `/cgi-zappi-mode-Z${zappiSerial}-${modeToUse}-0-0-0000`;
  const keepMglPath = `/cgi-set-min-green-Z${zappiSerial}-${mgl}`;

  const modeResult = await getJson(client, keepModePath);
  console.log(`  - keep mode response: ${JSON.stringify(modeResult)}`);

  const mglResult = await getJson(client, keepMglPath);
  console.log(`  - keep mgl response: ${JSON.stringify(mglResult)}`);

  console.log("Done.");
}

main().catch((error) => {
  console.error(`Probe failed: ${error.message}`);
  process.exit(1);
});
