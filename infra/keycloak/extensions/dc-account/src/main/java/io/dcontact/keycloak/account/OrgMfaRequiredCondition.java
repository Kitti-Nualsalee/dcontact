package io.dcontact.keycloak.account;

import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.authenticators.conditional.ConditionalAuthenticator;
import org.keycloak.models.AuthenticatorConfigModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/**
 * AC2 (#595): condition {@code dc-org-mfa-required} — true when the user is a member of an Organization that has {@code
 * dc_mfa_required=true}
 *
 * <p>Used in the tenant browser flow (`dcontact-browser`):
 *
 * <ul>
 *   <li>subflow "Org 2FA": this condition + {@code auth-otp-form} as REQUIRED — if there is no OTP yet, Keycloak
 *       sets the required action {@code CONFIGURE_TOTP}; if there is, it asks for the OTP
 *   <li>the existing 2FA subflow: add this condition as {@code negate} so the OTP is not asked twice
 * </ul>
 *
 * <p>Evaluated at login only, so it takes effect at the next login and does not cut a session in use (#589 D10, ADR-026)
 */
public class OrgMfaRequiredCondition implements ConditionalAuthenticator {

  static final OrgMfaRequiredCondition SINGLETON = new OrgMfaRequiredCondition();

  @Override
  public boolean matchCondition(AuthenticationFlowContext context) {
    boolean required = TenantOrganizations.mfaRequiredFor(context.getSession(), context.getUser());
    return negate(context.getAuthenticatorConfig()) != required;
  }

  static boolean negate(AuthenticatorConfigModel config) {
    return config != null
        && config.getConfig() != null
        && Boolean.parseBoolean(config.getConfig().get(OrgMfaRequiredConditionFactory.NEGATE));
  }

  @Override
  public void action(AuthenticationFlowContext context) {}

  @Override
  public boolean requiresUser() {
    return true;
  }

  @Override
  public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) {}

  @Override
  public void close() {}
}
