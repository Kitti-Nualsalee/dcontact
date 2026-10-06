package io.dcontact.keycloak.account;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;

/**
 * AC2 (#595): Organization ของ tenant หาได้จาก attribute {@code tenant_id} ที่ provisioning ตั้งไว้ (ADR-004)
 *
 * <p>การบังคับ 2FA ของ tenant เก็บใน attribute {@code dc_mfa_required} ของ Organization เดียวกัน — API ของ
 * D-Contact เป็นเจ้าของค่า (ตาราง {@code tenant_account_policies}) และ sync มาที่นี่ผ่าน {@link
 * DcAccountResource}
 */
final class TenantOrganizations {

  static final String TENANT_ATTRIBUTE = "tenant_id";
  static final String MFA_REQUIRED_ATTRIBUTE = "dc_mfa_required";

  private static final Pattern UUID =
      Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

  private TenantOrganizations() {}

  static boolean isTenantId(String value) {
    return value != null && UUID.matcher(value).matches();
  }

  /** Organization เดียวของ tenant — ไม่พบหรือพบมากกว่าหนึ่ง (ข้อมูลผิด) = {@code null} */
  static OrganizationModel byTenant(KeycloakSession session, String tenantId) {
    OrganizationProvider organizations = session.getProvider(OrganizationProvider.class);
    if (organizations == null || !organizations.isEnabled() || !isTenantId(tenantId)) return null;
    List<OrganizationModel> found =
        organizations.getAllStream(Map.of(TENANT_ATTRIBUTE, tenantId), 0, 2).toList();
    return found.size() == 1 ? found.get(0) : null;
  }

  static boolean isMember(KeycloakSession session, OrganizationModel organization, UserModel user) {
    OrganizationProvider organizations = session.getProvider(OrganizationProvider.class);
    return organizations != null && organizations.isMember(organization, user);
  }

  static boolean mfaRequired(OrganizationModel organization) {
    List<String> values = organization.getAttributes().get(MFA_REQUIRED_ATTRIBUTE);
    return values != null && values.contains("true");
  }

  /** ผู้ใช้เป็นสมาชิก Organization ที่เปิดอยู่และบังคับ 2FA อย่างน้อยหนึ่งแห่ง */
  static boolean mfaRequiredFor(KeycloakSession session, UserModel user) {
    OrganizationProvider organizations = session.getProvider(OrganizationProvider.class);
    if (user == null || organizations == null || !organizations.isEnabled()) return false;
    return organizations
        .getByMember(user)
        .anyMatch(organization -> organization.isEnabled() && mfaRequired(organization));
  }
}
