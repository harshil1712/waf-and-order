/**
 * Direct deterministic GraphQL Analytics client.
 *
 * The collector talks directly to the GraphQL Analytics API using the shared
 * read-only token (`CLOUDFLARE_READ_TOKEN`). This is deterministic code owned
 * by the scheduled handler, not model-reinvented collection: the pipeline must
 * not depend on the model reinventing the core collection query every day.
 *
 * Query windows are capped at one day: `httpRequestsAdaptiveGroups`
 * on this plan limits each query to at most one day, so daily collection is
 * required.
 */

/** The GraphQL Analytics endpoint. */
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Errors returned by the GraphQL Analytics API. */
export interface GraphQLError {
  message: string;
}

/** The raw GraphQL Analytics response body shape. */
export interface GraphQLResponse<Data = unknown> {
  data?: Data;
  errors?: GraphQLError[];
}

/** A single adaptive-groups result row as returned by the API. */
export interface AdaptiveGroupsRow {
  count?: number;
  sum?: { edgeResponseBytes?: number };
  dimensions?: Record<string, string | number | boolean | null>;
}

/** Thrown when the GraphQL Analytics API rejects a deterministic query. */
class GraphQLQueryError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "GraphQLQueryError";
    this.status = status;
  }
}

/**
 * Execute one GraphQL query against the Analytics API. Throws on a
 * non-2xx HTTP response or when the API reports a query-level error.
 */
export async function queryGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new GraphQLQueryError(
      `GraphQL Analytics query failed with HTTP ${response.status}: ${response.statusText}`,
      response.status,
    );
  }

  const body = (await response.json()) as GraphQLResponse;
  if (body.errors && body.errors.length > 0) {
    throw new GraphQLQueryError(
      `GraphQL Analytics query returned errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return body;
}
