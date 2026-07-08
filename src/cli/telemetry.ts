type Capture = { event: string; properties?: Record<string, unknown> };

type TelemetryClient = {
  capture(input: Capture): void;
  shutdown(): Promise<void>;
};

export async function createTelemetryClient(): Promise<TelemetryClient> {
  if (process.env.GITWORTHY_TELEMETRY !== 'on' || !process.env.GITWORTHY_POSTHOG_KEY) {
    return { capture: () => undefined, shutdown: async () => undefined };
  }
  const imported = await import('posthog-node');
  const PostHog = imported.PostHog;
  const client = new PostHog(process.env.GITWORTHY_POSTHOG_KEY, { host: 'https://us.i.posthog.com' });
  return {
    capture: (input) => client.capture({ distinctId: 'gitworthy-cli', event: input.event, properties: input.properties }),
    shutdown: () => client.shutdown()
  };
}
