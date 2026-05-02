import "dotenv/config";

const ASANA_API_BASE_URL = "https://app.asana.com/api/1.0";

interface AsanaResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; phrase?: string; help?: string }>;
}

interface AsanaUser {
  gid: string;
  name?: string;
  email?: string;
  workspaces?: Array<{ gid: string; name?: string }>;
}

interface AsanaTask {
  gid: string;
  name?: string;
  assignee?: { gid?: string; name?: string } | null;
  workspace?: { gid?: string; name?: string };
  due_on?: string | null;
  permalink_url?: string;
}

async function main(): Promise<void> {
  const token = process.env.ASANA_PAT;
  if (!token) {
    throw new Error("Missing ASANA_PAT. Run: ASANA_PAT=your_pat pnpm debug:asana-create");
  }

  const args = new Set(process.argv.slice(2));
  const keepTask = args.has("--keep");
  const me = await asanaRequest<AsanaUser>(
    token,
    "/users/me?opt_fields=gid,name,email,workspaces.gid,workspaces.name"
  );

  const workspaceGid = process.env.ASANA_WORKSPACE_GID ?? me.workspaces?.[0]?.gid;
  const assigneeGid = process.env.ASANA_ASSIGNEE_GID ?? me.gid;
  const dueOn = process.env.ASANA_DEBUG_DUE_ON ?? tomorrowDate();
  const taskName =
    process.env.ASANA_DEBUG_TASK_NAME ??
    `SuperAgent PAT assigned-create probe ${new Date().toISOString()}`;

  if (!workspaceGid) {
    throw new Error("Could not infer a workspace. Set ASANA_WORKSPACE_GID and retry.");
  }

  console.log(
    JSON.stringify(
      {
        step: "resolved_context",
        user: { gid: me.gid, name: me.name, email: me.email },
        workspaceGid,
        assigneeGid,
        dueOn,
        keepTask
      },
      null,
      2
    )
  );

  let task: AsanaTask | undefined;
  try {
    task = await asanaRequest<AsanaTask>(
      token,
      "/tasks?opt_fields=gid,name,assignee.gid,assignee.name,workspace.gid,workspace.name,due_on,permalink_url",
      {
        method: "POST",
        body: {
          data: {
            name: taskName,
            workspace: workspaceGid,
            assignee: assigneeGid,
            due_on: dueOn
          }
        }
      }
    );

    console.log(
      JSON.stringify(
        {
          status: "assigned_create_succeeded",
          task: {
            gid: task.gid,
            name: task.name,
            assignee: task.assignee,
            workspace: task.workspace,
            dueOn: task.due_on,
            url: task.permalink_url
          }
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          status: "assigned_create_failed",
          diagnosis:
            "PAT failed on the same assigned-create shape. This points to an Asana workspace/account/API issue rather than the OAuth app path.",
          error: serializeError(error)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  if (!keepTask && task?.gid) {
    await asanaRequest(token, `/tasks/${task.gid}`, { method: "DELETE" });
    console.log(JSON.stringify({ status: "deleted_probe_task", taskGid: task.gid }, null, 2));
  }
}

async function asanaRequest<T>(
  token: string,
  path: string,
  input: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${ASANA_API_BASE_URL}${path}`, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(input.body ? { "Content-Type": "application/json" } : {})
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });

  const payload = (await response.json().catch(() => ({}))) as AsanaResponse<T>;
  if (!response.ok) {
    const firstError = payload.errors?.[0];
    const message = firstError?.message ?? `HTTP ${response.status}`;
    const phrase = firstError?.phrase;
    throw new Error(`Asana ${response.status}: ${message}${phrase ? `; phrase=${phrase}` : ""}`);
  }

  return payload.data as T;
}

function tomorrowDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

void main().catch((error) => {
  console.error(
    JSON.stringify({ status: "debug_script_failed", error: serializeError(error) }, null, 2)
  );
  process.exitCode = 1;
});
