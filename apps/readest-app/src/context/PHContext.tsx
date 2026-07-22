'use client';

import posthog from 'posthog-js';
import { ReactNode } from 'react';
import { PostHogProvider } from 'posthog-js/react';

// Tracking removed in this (Flutter-embed) fork: PostHog is never initialized,
// so every posthog.capture()/identify()/opt_*_capturing() call across the app
// is an inert no-op that sends nothing over the network. The provider is kept
// with the uninitialized client so usePostHog() consumers still receive a valid
// object and don't crash.
export const CSPostHogProvider = ({ children }: { children: ReactNode }) => {
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
};
