import type { IssueProvider, ParsedIssueUrl } from './types.js';

/**
 * Result of multi-provider URL parsing, includes which provider matched
 */
export interface ParsedIssueUrlWithProvider extends ParsedIssueUrl {
  provider: IssueProvider;
}

/**
 * Try to parse an issue URL from a description using multiple providers.
 * Returns the first successful parse, or null if no provider matches.
 */
export function parseIssueUrlFromAnyProvider(
  description: string | null | undefined,
  providers: Iterable<IssueProvider>
): ParsedIssueUrlWithProvider | null {
  if (!description) return null;

  for (const provider of providers) {
    const parsed = provider.parseIssueUrl(description);
    if (parsed) {
      return { ...parsed, provider };
    }
  }

  return null;
}
