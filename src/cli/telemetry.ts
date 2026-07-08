type Capture = { event: string; properties?: Record<string, unknown> };

type TelemetryClient = {
  capture(input: Capture): void;
  shutdown(): Promise<void>;
};

type PostHogConstructor = new (key: string, options: { host: string }) => {
  capture(input: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown(): Promise<void>;
};

type PostHogModule = { PostHog: PostHogConstructor };

const noopClient: TelemetryClient = { capture: () => undefined, shutdown: async () => undefined };

async function optionalImportPostHog(): Promise<PostHogModule | null> {
  try {
    const importOptional = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PostHogModule>;
    return await importOptional('posthog-node');
  } catch {
    process.stderr.write('gitworthy telemetry requested but optional package posthog-node is not installed. Continuing with telemetry disabled.\n');
    return null;
  }
}

export async function createTelemetryClient(): Promise<TelemetryClient> {
  if (process.env.GITWORTHY_TELEMETRY !== 'on' || !process.env.GITWORTHY_POSTHOG_KEY) {
    return noopClient;
  }
  const imported = await optionalImportPostHog();
  if (!imported) return noopClient;
  const client = new imported.PostHog(process.env.GITWORTHY_POSTHOG_KEY, { host: 'https://us.i.posthog.com' });
  return {
    capture: (input) => client.capture({ distinctId: 'gitworthy-cli', event: input.event, properties: input.properties }),
    shutdown: () => client.shutdown()
  };
}
