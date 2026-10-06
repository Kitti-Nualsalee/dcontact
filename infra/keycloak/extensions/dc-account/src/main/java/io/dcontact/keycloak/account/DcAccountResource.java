package io.dcontact.keycloak.account;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.keycloak.credential.CredentialModel;
import org.keycloak.credential.CredentialProvider;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OTPPolicy;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.OTPCredentialModel;
import org.keycloak.models.utils.CredentialValidation;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;

/**
 * AC2 (#595): realm resource {@code /realms/{realm}/dc-account} ที่ API ของ D-Contact เรียกจากฝั่ง server
 *
 * <ul>
 *   <li>{@code POST /users/{userId}/totp/verify-and-create} {@code { tenantId, secret, code, label }} —
 *       ตรวจ code ด้วย OTP policy ของ realm แล้วสร้าง OTP credential แทนผู้ใช้ (ผู้ใช้สแกน QR ในหน้า
 *       D-Contact ไม่ต้องเห็นหน้าของ identity provider)
 *   <li>{@code PUT /organizations/by-tenant/{tenantId}/mfa-required} {@code { required }} — sync การบังคับ
 *       2FA ของ tenant (เจ้าของค่าคือ API, AC1) ไปที่ attribute {@code dc_mfa_required} ของ Organization
 * </ul>
 *
 * <p>ขอบเขตสิทธิ์ (ADR-033): รับเฉพาะ access token ของ service account {@code dcontact-account-service};
 * แตะได้เฉพาะผู้ใช้ที่เป็นสมาชิก Organization ของ tenant ที่ระบุ และแก้ได้เฉพาะ attribute ข้างบนของ
 * Organization — account service จึงไม่ต้องมีสิทธิ์จัดการ Organization ผ่าน Admin REST
 *
 * <p>ไม่ log secret, code หรือ label และ error ตอบเป็น {@code { code }} คงที่ ไม่สะท้อนค่าที่ส่งมา
 */
public class DcAccountResource {

  static final String ACCOUNT_SERVICE_CLIENT = "dcontact-account-service";
  static final int MAX_LABEL_LENGTH = 64;

  /** secret ที่ API สร้าง (เก็บใน Keycloak ตามตัวอักษร, QR ใช้ Base32 ของ bytes) — ASCII ที่พิมพ์ได้ ไม่มีช่องว่าง */
  private static final Pattern SECRET = Pattern.compile("^[\\x21-\\x7E]{16,128}$");

  private static final Pattern DIGITS = Pattern.compile("^[0-9]+$");

  private final KeycloakSession session;

  public DcAccountResource(KeycloakSession session) {
    this.session = session;
  }

  @POST
  @Path("users/{userId}/totp/verify-and-create")
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Response verifyAndCreateTotp(
      @PathParam("userId") String userId, Map<String, Object> body) {
    Response denied = authorize();
    if (denied != null) return denied;
    RealmModel realm = session.getContext().getRealm();

    String tenantId = text(body, "tenantId");
    String secret = text(body, "secret");
    String code = text(body, "code");
    String label = text(body, "label");
    label = label == null ? null : label.trim();
    if (!TenantOrganizations.isTenantId(tenantId)) return error(400, "INVALID_TENANT");
    if (secret == null || !SECRET.matcher(secret).matches()) return error(400, "INVALID_SECRET");
    if (label == null || label.isEmpty() || label.length() > MAX_LABEL_LENGTH) {
      return error(400, "INVALID_LABEL");
    }
    OTPPolicy policy = realm.getOTPPolicy();
    if (code == null || code.length() != policy.getDigits() || !DIGITS.matcher(code).matches()) {
      return error(400, "INVALID_OTP_CODE");
    }

    OrganizationModel organization = TenantOrganizations.byTenant(session, tenantId);
    if (organization == null) return error(404, "ORGANIZATION_NOT_FOUND");
    UserModel user = userId == null ? null : session.users().getUserById(realm, userId);
    if (user == null || user.getServiceAccountClientLink() != null) {
      return error(404, "USER_NOT_FOUND");
    }
    // ผู้ใช้ต้องอยู่ใน Organization ของ tenant เดียวกับผู้เรียก — platform user/ผู้ใช้ tenant อื่นแตะไม่ได้
    if (!TenantOrganizations.isMember(session, organization, user)) {
      return error(403, "USER_NOT_IN_ORGANIZATION");
    }
    String requestedLabel = label;
    boolean labelTaken =
        user.credentialManager()
            .getStoredCredentialsByTypeStream(OTPCredentialModel.TYPE)
            .anyMatch(existing -> requestedLabel.equals(existing.getUserLabel()));
    if (labelTaken) return error(409, "LABEL_IN_USE");

    OTPCredentialModel credential = OTPCredentialModel.createFromPolicy(realm, secret, label);
    // code ผิด = ไม่สร้าง credential เลย (ตรวจก่อนเขียน ไม่ใช่สร้างแล้วลบ)
    if (!CredentialValidation.validOTP(code, credential, policy.getLookAheadWindow())) {
      return error(400, "INVALID_OTP_CODE");
    }
    @SuppressWarnings("unchecked")
    CredentialProvider<OTPCredentialModel> otp =
        session.getProvider(CredentialProvider.class, "keycloak-otp");
    CredentialModel created = otp.createCredential(realm, user, credential);
    return Response.status(201)
        .entity(Map.of("credentialId", created.getId()))
        .type(MediaType.APPLICATION_JSON)
        .build();
  }

  @PUT
  @Path("organizations/by-tenant/{tenantId}/mfa-required")
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Response setMfaRequired(@PathParam("tenantId") String tenantId, Map<String, Object> body) {
    Response denied = authorize();
    if (denied != null) return denied;
    Object required = body == null ? null : body.get("required");
    if (!(required instanceof Boolean)) return error(400, "INVALID_REQUIRED");
    if (!TenantOrganizations.isTenantId(tenantId)) return error(400, "INVALID_TENANT");
    OrganizationModel organization = TenantOrganizations.byTenant(session, tenantId);
    if (organization == null) return error(404, "ORGANIZATION_NOT_FOUND");
    // setAttributes แทนทั้งชุด — คัดลอกของเดิม (tenant_id, tenant_slug, ...) แล้วเปลี่ยนเฉพาะ key เดียว
    Map<String, List<String>> attributes = new HashMap<>(organization.getAttributes());
    attributes.put(
        TenantOrganizations.MFA_REQUIRED_ATTRIBUTE, List.of(String.valueOf((Boolean) required)));
    organization.setAttributes(attributes);
    return Response.noContent().build();
  }

  /** {@code null} = ผ่าน; ไม่มี/ไม่ถูกต้อง → 401, token ของ client อื่นหรือผู้ใช้ทั่วไป → 403 */
  private Response authorize() {
    AuthResult auth = new AppAuthManager.BearerTokenAuthenticator(session).authenticate();
    if (auth == null) return error(401, "UNAUTHORIZED");
    ClientModel client = auth.client();
    UserModel caller = auth.user();
    boolean accountService =
        client != null
            && client.isEnabled()
            && ACCOUNT_SERVICE_CLIENT.equals(client.getClientId())
            && caller != null
            && client.getId().equals(caller.getServiceAccountClientLink());
    return accountService ? null : error(403, "FORBIDDEN");
  }

  private static String text(Map<String, Object> body, String key) {
    Object value = body == null ? null : body.get(key);
    return value instanceof String string ? string : null;
  }

  private static Response error(int status, String code) {
    return Response.status(status)
        .entity(Map.of("code", code))
        .type(MediaType.APPLICATION_JSON)
        .build();
  }
}
