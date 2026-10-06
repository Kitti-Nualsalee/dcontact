package io.dcontact.keycloak.account;

import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.authenticators.conditional.ConditionalAuthenticator;
import org.keycloak.models.AuthenticatorConfigModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/**
 * AC2 (#595): condition {@code dc-org-mfa-required} — จริงเมื่อผู้ใช้เป็นสมาชิก Organization ที่ตั้ง {@code
 * dc_mfa_required=true}
 *
 * <p>ใช้ใน browser flow ของ tenant (`dcontact-browser`):
 *
 * <ul>
 *   <li>subflow "Org 2FA": condition นี้ + {@code auth-otp-form} แบบ REQUIRED — ยังไม่มี OTP = Keycloak
 *       ตั้ง required action {@code CONFIGURE_TOTP}; มีแล้ว = ถาม OTP
 *   <li>subflow 2FA เดิม: เพิ่ม condition นี้แบบ {@code negate} เพื่อไม่ถาม OTP ซ้ำสองรอบ
 * </ul>
 *
 * <p>ประเมินตอน login เท่านั้น จึงมีผลตอน login ครั้งถัดไปและไม่ตัด session ที่ใช้อยู่ (#589 D10, ADR-026)
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
