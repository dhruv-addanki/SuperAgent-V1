interface AdminWhatsappCliOptions {
  baseUrl: string;
  token: string;
  endpoint:
    | "/admin/whatsapp/outbound"
    | "/admin/whatsapp/outbound/confirm"
    | "/admin/whatsapp/outbound/cancel";
  body: Record<string, unknown>;
}

export function parseAdminWhatsappArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): AdminWhatsappCliOptions {
  const args = parseArgs(argv);
  const baseUrl = stripTrailingSlash(
    args["base-url"] ?? env.ADMIN_API_BASE_URL ?? env.APP_BASE_URL ?? "http://localhost:3000"
  );
  const token = args.token ?? env.ADMIN_API_TOKEN;
  if (!token) throw new Error("Missing ADMIN_API_TOKEN or --token.");

  if (args.confirm) {
    return {
      baseUrl,
      token,
      endpoint: "/admin/whatsapp/outbound/confirm",
      body: { approvalCode: args.confirm }
    };
  }

  if (args.cancel) {
    return {
      baseUrl,
      token,
      endpoint: "/admin/whatsapp/outbound/cancel",
      body: { approvalCode: args.cancel }
    };
  }

  const phone = args.phone;
  if (!phone) throw new Error("Missing --phone.");

  if (args.exact) {
    return {
      baseUrl,
      token,
      endpoint: "/admin/whatsapp/outbound",
      body: {
        phone,
        mode: "exact",
        message: args.exact
      }
    };
  }

  if (args.prompt) {
    return {
      baseUrl,
      token,
      endpoint: "/admin/whatsapp/outbound",
      body: {
        phone,
        mode: "draft",
        instruction: args.prompt
      }
    };
  }

  throw new Error("Use --exact, --prompt, --confirm, or --cancel.");
}

async function main(): Promise<void> {
  const options = parseAdminWhatsappArgs(process.argv.slice(2));
  const response = await fetch(`${options.baseUrl}${options.endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(options.body)
  });
  const text = await response.text();
  const formatted = formatResponseBody(text);
  if (!response.ok) {
    console.error(formatted);
    process.exitCode = 1;
    return;
  }
  console.log(formatted);
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function formatResponseBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

if (
  process.argv[1]?.endsWith("adminWhatsapp.ts") ||
  process.argv[1]?.endsWith("adminWhatsapp.js")
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
