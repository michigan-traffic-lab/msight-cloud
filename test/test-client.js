const BASE_URL = 'https://6ngwyshn4e.execute-api.us-east-1.amazonaws.com';

async function timedFetch(url, options) {
  const startedAt = Date.now();
  const res = await fetch(url, options);
  const rttMs = Date.now() - startedAt;
  return { res, rttMs };
}

async function printResponse(title, res, rttMs) {
  console.log(`\n=== ${title} ===`);
  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log(`RTT ${rttMs} ms`);

  const text = await res.text();
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
  }
}

async function testSystemHealth() {
  const { res, rttMs } = await timedFetch(`${BASE_URL}/system/health`);
  await printResponse('System Health', res, rttMs);
}

async function testLocationHealth() {
  const { res, rttMs } = await timedFetch(`${BASE_URL}/v1/clients/location/health`);
  await printResponse('Location Health', res, rttMs);
}

async function testOpenApi() {
  const { res, rttMs } = await timedFetch(`${BASE_URL}/system/openapi.json`);
  await printResponse('OpenAPI', res, rttMs);
}

async function testLocationUpdate() {
  const payload = {
    app_id: 'msight-demo',
    client_id: 'client-001',
    timestamp: new Date().toISOString(),
    location: {
      lat: 42.2808,
      lon: -83.7430,
      alt: 255.4,
      horizontal_accuracy_m: 3.5,
      confidence: 0.94,
      speed_mps: 12.1,
      heading_deg: 87.2,
      fix_type: '3d',
      satellites_visible: 14,
      hdop: 0.9,
      source: 'gps',
    },
  };

  const { res, rttMs } = await timedFetch(`${BASE_URL}/v1/clients/location/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  await printResponse('Location Update (Valid)', res, rttMs);
}

async function testInvalidLocationUpdate() {
  const badPayload = {
    app_id: 'msight-demo',
    client_id: 'client-001',
    timestamp: new Date().toISOString(),
    location: {
      lat: 999, // invalid
      lon: -83.7430,
    },
  };

  const { res, rttMs } = await timedFetch(`${BASE_URL}/v1/clients/location/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(badPayload),
  });

  await printResponse('Location Update (Invalid)', res, rttMs);
}

async function main() {
  try {
    await testSystemHealth();
    await testLocationHealth();
    await testOpenApi();
    await testLocationUpdate();
    await testInvalidLocationUpdate();
  } catch (err) {
    console.error('\nError running tests:', err);
  }
}

main();