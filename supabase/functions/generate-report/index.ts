
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://insightpilotai.netlify.app",
]);

const MAX_FILE_SIZE = 15 * 1024 * 1024;

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  const headers = corsHeaders(origin);

  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  // Handle browser CORS preflight before authentication.
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(null, { status: 403 });
    }

    const headers = corsHeaders(origin);

    return new Response(null, {
      status: 204,
      headers,
    });
  }

  // Reject requests from origins not on the allowlist.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse(
      { error: "Origin not allowed." },
      403,
      origin,
    );
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405,
      origin,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
  const n8nUrl = Deno.env.get("N8N_WEBHOOK_URL");
  const n8nSecret = Deno.env.get("N8N_WEBHOOK_SECRET");

  if (!supabaseUrl || !supabaseKey || !n8nUrl || !n8nSecret) {
    console.error("A required server environment variable is missing.");

    return jsonResponse(
      { error: "Server configuration is incomplete." },
      500,
      origin,
    );
  }

  // Require a signed-in user.
  const authorization = req.headers.get("Authorization") ?? "";
  const tokenMatch = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!tokenMatch) {
    return jsonResponse(
      { error: "Please sign in again." },
      401,
      origin,
    );
  }

  // Validate the access token with Supabase Auth.
  let authResponse: Response;

  try {
    authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${tokenMatch[1]}`,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error("Supabase Auth request failed:", String(error));

    return jsonResponse(
      { error: "Authentication service is temporarily unavailable." },
      502,
      origin,
    );
  }

  if (!authResponse.ok) {
    return jsonResponse(
      { error: "Your session is invalid or expired. Please sign in again." },
      401,
      origin,
    );
  }

  let user: {
    email?: string;
    email_confirmed_at?: string | null;
  };

  try {
    user = await authResponse.json();
  } catch {
    return jsonResponse(
      { error: "Could not verify your account." },
      502,
      origin,
    );
  }

  if (!user.email_confirmed_at) {
    return jsonResponse(
      { error: "Please verify your email first." },
      403,
      origin,
    );
  }

  // Require a multipart form containing the uploaded file.
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return jsonResponse(
      { error: "Submit the report form with its file." },
      400,
      origin,
    );
  }

  let form: FormData;

  try {
    form = await req.formData();
  } catch {
    return jsonResponse(
      { error: "Invalid form data." },
      400,
      origin,
    );
  }

  const businessName = form.get("business_name");
  const industry = form.get("industry");
  const reportingPeriod = form.get("reporting_period");
  const question = form.get("business_question");
  const file = form.get("business_file");

  if (
    typeof businessName !== "string" ||
    businessName.trim().length < 2 ||
    businessName.trim().length > 120
  ) {
    return jsonResponse(
      { error: "Enter a valid company name." },
      400,
      origin,
    );
  }

  if (
    typeof industry !== "string" ||
    industry.trim().length < 2 ||
    industry.trim().length > 100
  ) {
    return jsonResponse(
      { error: "Enter a valid industry." },
      400,
      origin,
    );
  }

  if (
    typeof reportingPeriod !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(reportingPeriod)
  ) {
    return jsonResponse(
      { error: "Enter a valid reporting date." },
      400,
      origin,
    );
  }

  const parsedDate = new Date(`${reportingPeriod}T00:00:00.000Z`);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== reportingPeriod
  ) {
    return jsonResponse(
      { error: "The reporting date is invalid." },
      400,
      origin,
    );
  }

  if (
    typeof question !== "string" ||
    question.length > 3000
  ) {
    return jsonResponse(
      { error: "The business question is too long." },
      400,
      origin,
    );
  }

  if (!(file instanceof File) || file.size === 0) {
    return jsonResponse(
      { error: "Upload a CSV or Excel file." },
      400,
      origin,
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return jsonResponse(
      { error: "The file must be 15 MB or smaller." },
      413,
      origin,
    );
  }

  if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
    return jsonResponse(
      { error: "Only CSV, XLSX, and XLS files are allowed." },
      400,
      origin,
    );
  }

  // Build a new form using only the approved fields.
  const forwardForm = new FormData();

  forwardForm.set("business_name", businessName.trim());
  forwardForm.set("industry", industry.trim());
  forwardForm.set("reporting_period", reportingPeriod);
  forwardForm.set("email", user.email ?? "");
  forwardForm.set("business_question", question.trim());
  forwardForm.set("business_file", file, file.name);

  // Forward the request securely to the existing n8n workflow.
  try {
    const n8nResponse = await fetch(n8nUrl, {
      method: "POST",
      headers: {
        "X-InsightPilot-Gateway": n8nSecret,
      },
      body: forwardForm,
      signal: AbortSignal.timeout(120000),
    });

    const responseText = await n8nResponse.text();

    if (!n8nResponse.ok) {
      console.error(
        "n8n returned HTTP status:",
        n8nResponse.status,
      );

      return jsonResponse(
        { error: "Report generation failed. Please try again later." },
        502,
        origin,
      );
    }

    let result: unknown;

    try {
      result = JSON.parse(responseText);
    } catch {
      console.error("n8n returned a non-JSON response.");

      return jsonResponse(
        { error: "The report service returned an unexpected response." },
        502,
        origin,
      );
    }

    return jsonResponse(result, 200, origin);
  } catch (error) {
    console.error("Report gateway request failed:", String(error));

    return jsonResponse(
      { error: "The report service could not be reached." },
      502,
      origin,
    );
  }
});
