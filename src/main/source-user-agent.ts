interface SourceUserAgentSession { getUserAgent(): string; setUserAgent(userAgent: string): void }

/** Use the existing consumer-page UA for the same session's media requests as well. */
export function synchronizeSourceUserAgent(sourceSession: SourceUserAgentSession): string {
  const previous = sourceSession.getUserAgent();
  const userAgent = previous.replace(/\sElectron\/\S+/g, '').replace(/\sread-later-workbench\/\S+/g, '');
  if (userAgent !== previous) sourceSession.setUserAgent(userAgent);
  return userAgent;
}
