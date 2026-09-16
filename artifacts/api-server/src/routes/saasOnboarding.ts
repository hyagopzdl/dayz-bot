import { Router } from "express";
import { requirePortalAuth } from "../middlewares/portalAuth";
import { isOrganizationSecretEncryptionConfigured } from "../lib/organizationIntegrations";
import { isSaasSelfServiceEnabled } from "../lib/organizationRegistry";
import { renderSaasOnboarding } from "./saasOnboardingView";

const router = Router();

router.get("/onboarding", requirePortalAuth, (req, res) => {
  res.type("html").send(
    renderSaasOnboarding(
      req.portalSession!,
      isSaasSelfServiceEnabled() && isOrganizationSecretEncryptionConfigured(),
    ),
  );
});

export default router;
