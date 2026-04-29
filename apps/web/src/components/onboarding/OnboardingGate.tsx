/**
 * OnboardingGate — checks the user's profile on mount and renders the
 * OnboardingWizard if they haven't completed onboarding.
 *
 * Mount once, near the top of the authenticated tree (inside
 * OnboardingProvider). Self-dismissing: once onboarded_at is set, the
 * gate stops showing.
 */
import { useEffect, useState } from 'react';
import { getProfile, type UserProfile } from '@/services/onboardingApi';
import { OnboardingWizard } from './OnboardingWizard';

export function OnboardingGate() {
  const [show, setShow] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (checked) return;
    getProfile()
      .then((p: UserProfile) => {
        if (!p.onboarded_at) setShow(true);
      })
      .catch(() => {
        // Profile endpoint failed — don't surprise the user with a wizard
        // they didn't ask for. Skip silently.
      })
      .finally(() => setChecked(true));
  }, [checked]);

  if (!show) return null;
  return <OnboardingWizard onClose={() => setShow(false)} />;
}
