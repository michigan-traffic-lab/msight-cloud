/**
 * Direct calls to the stack's public API, made from the browser.
 *
 * Latency has to be measured here, not in the admin Lambda. A Lambda probing an
 * API Gateway in the same region measures an in-datacentre hop of a few tens of
 * milliseconds — a number that is real but answers a question nobody asked. What
 * matters is the round trip a client actually experiences, which includes DNS,
 * TLS, and the path across the internet, and only the browser can see that.
 *
 * These endpoints are unauthenticated and allow any origin, so no token is sent.
 */

export interface LatencyProbe {
  status: 'ok' | 'error';
  latency_ms: number | null;
  error?: string;
}

export interface LatencyProbeResponse {
  status: 'ok' | 'degraded';
  service: string;
  api_version: string;
  build_id: string;
  server_received_timestamp: string;
  server_response_timestamp: string;
  connectivity: {
    source_ip: string;
    protocol: string;
    domain_name: string;
  };
  probes: {
    valkey: LatencyProbe;
    postgresql: LatencyProbe;
  };
}

export interface LatencyMeasurement {
  /** Wall-clock round trip as the browser sees it. */
  round_trip_ms: number;
  /** Time the API spent between receiving and answering. */
  server_ms: number | null;
  /** Round trip minus server time: network, TLS and gateway overhead. */
  network_ms: number | null;
  valkey: LatencyProbe;
  postgresql: LatencyProbe;
  source_ip: string;
  protocol: string;
  measured_at: string;
}

async function timedFetch(url: string, signal?: AbortSignal) {
  // performance.now() is monotonic, so a clock adjustment mid-request cannot
  // produce a negative or wildly wrong duration.
  const startedAt = performance.now();
  // The key is omitted rather than set to undefined: RequestInit types signal
  // as `AbortSignal | null`, which under exactOptionalPropertyTypes does not
  // accept an explicit undefined.
  const response = await fetch(url, {
    ...(signal ? { signal } : {}),
    cache: 'no-store',
  });
  const elapsed = performance.now() - startedAt;
  return { response, elapsed };
}

/**
 * Measures end-to-end latency against the existing `/v1/client/latency`
 * endpoint, and decomposes it using the timestamps that endpoint already
 * reports.
 */
export async function measureLatency(
  baseUrl: string,
  signal?: AbortSignal
): Promise<LatencyMeasurement> {
  const { response, elapsed } = await timedFetch(`${baseUrl}/v1/client/latency`, signal);

  if (!response.ok) {
    throw new Error(`Latency endpoint returned HTTP ${response.status}.`);
  }

  const body = (await response.json()) as LatencyProbeResponse;

  const received = Date.parse(body.server_received_timestamp);
  const answered = Date.parse(body.server_response_timestamp);
  const serverMs =
    Number.isFinite(received) && Number.isFinite(answered) ? answered - received : null;

  return {
    round_trip_ms: Math.round(elapsed),
    server_ms: serverMs,
    // Clamp at zero: the two clocks are different machines, so a fast request
    // can otherwise produce a small negative remainder.
    network_ms: serverMs === null ? null : Math.max(0, Math.round(elapsed - serverMs)),
    valkey: body.probes.valkey,
    postgresql: body.probes.postgresql,
    source_ip: body.connectivity.source_ip,
    protocol: body.connectivity.protocol,
    measured_at: new Date().toISOString(),
  };
}

export interface EndpointCheck {
  ok: boolean;
  status: number;
  round_trip_ms: number;
  checked_at: string;
}

/** Simple reachability check, also timed from the browser. */
export async function checkEndpoint(
  url: string,
  signal?: AbortSignal
): Promise<EndpointCheck> {
  const { response, elapsed } = await timedFetch(url, signal);
  return {
    ok: response.ok,
    status: response.status,
    round_trip_ms: Math.round(elapsed),
    checked_at: new Date().toISOString(),
  };
}
