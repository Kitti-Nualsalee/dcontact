package io.dcontact.keycloak.account;

import freemarker.template.Configuration;
import freemarker.template.Template;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.io.InputStream;
import java.io.StringReader;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
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
import org.keycloak.protocol.oidc.endpoints.IframeUtil;
import org.keycloak.protocol.oidc.endpoints.LoginStatusIframeEndpoint;
import org.keycloak.services.Urls;
import org.keycloak.utils.SecureContextResolver;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;

/**
 * AC2 (#595): realm resource {@code /realms/{realm}/dc-account} that the D-Contact API calls from the server side
 *
 * <ul>
 *   <li>{@code POST /users/{userId}/totp/verify-and-create} {@code { tenantId, secret, code, label }} —
 *       validates the code with the realm's OTP policy, then creates the OTP credential on behalf of the user (the user scans the QR in the
 *       D-Contact page without seeing the identity provider's page)
 *   <li>{@code PUT /organizations/by-tenant/{tenantId}/mfa-required} {@code { required }} — syncs the tenant's 2FA
 *       enforcement (the API, AC1, owns the value) to the {@code dc_mfa_required} attribute of the Organization
 * </ul>
 *
 * <p>Permission scope (ADR-033): accepts only the access token of the service account {@code dcontact-account-service};
 * it may touch only users who are members of the named tenant's Organization, and may change only the attribute above of the
 * Organization — so the account service does not need permission to manage Organizations through the Admin REST
 *
 * <p>It never logs a secret, code or label, and an error is answered as a fixed {@code { code }} that does not echo the submitted values
 */
public class DcAccountResource {

  static final String ACCOUNT_SERVICE_CLIENT = "dcontact-account-service";
  static final int MAX_LABEL_LENGTH = 64;

  /** secret created by the API (stored in Keycloak literally, the QR uses the Base32 of its bytes) — printable ASCII, no spaces */
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
    // the user must be in the Organization of the same tenant as the caller — a platform user/another tenant's user cannot be touched
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
    // a wrong code = no credential is created at all (validate before writing, not create then delete)
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
    // setAttributes replaces the whole set — copy the existing ones (tenant_id, tenant_slug, ...) and change only one key
    Map<String, List<String>> attributes = new HashMap<>(organization.getAttributes());
    attributes.put(
        TenantOrganizations.MFA_REQUIRED_ATTRIBUTE, List.of(String.valueOf((Boolean) required)));
    organization.setAttributes(attributes);
    return Response.noContent().build();
  }

  /**
   * R1 (#593) prototype: the OIDC session management iframe (`check_session_iframe`) that reads the cookie with the new name
   *
   * <p>Keycloak's original iframe is rendered from the classpath (it cannot be overridden by a theme) and reads {@code KEYCLOAK_SESSION}
   * directly — here we use the original Keycloak template of the running version, replacing only the cookie name (other behavior follows upstream)
   * if the original name cannot be found in the template (upstream changed), answer 500 rather than send an iframe that silently misbehaves
   */
  @GET
  @Path("login-status-iframe.html")
  @Produces(MediaType.TEXT_HTML)
  public Response loginStatusIframe(@QueryParam("version") String version) {
    return IframeUtil.returnIframe(version, session, this::renderLoginStatusIframe);
  }

  /** the client's origin is validated with Keycloak's existing code (the client's web origins) */
  @GET
  @Path("login-status-iframe.html/init")
  public Response loginStatusIframeInit(
      @QueryParam("client_id") String clientId, @QueryParam("origin") String origin) {
    return new LoginStatusIframeEndpoint(session).preCheck(clientId, origin);
  }

  static final String SESSION_COOKIE = "\"KEYCLOAK_SESSION\"";

  private Object renderLoginStatusIframe() {
    try (InputStream stream =
        LoginStatusIframeEndpoint.class.getResourceAsStream("login-status-iframe.ftl")) {
      if (stream == null) throw new IllegalStateException("login-status-iframe.ftl not found");
      String upstream = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
      if (!upstream.contains(SESSION_COOKIE)) {
        throw new IllegalStateException("login-status-iframe.ftl no longer reads KEYCLOAK_SESSION");
      }
      String patched =
          upstream.replace(
              SESSION_COOKIE, "\"" + DcCookieProvider.renamedName("KEYCLOAK_SESSION") + "\"");
      Map<String, Object> attributes = new HashMap<>();
      attributes.put("isSecureContext", SecureContextResolver.isSecureContext(session));
      attributes.put(
          "resourceCommonUrl",
          Urls.themeRoot(session.getContext().getUri(org.keycloak.urls.UrlType.FRONTEND).getBaseUri())
                  .getPath()
              + "/common/keycloak");
      Template template =
          new Template(
              "dc-login-status-iframe",
              new StringReader(patched),
              new Configuration(Configuration.VERSION_2_3_32));
      StringWriter html = new StringWriter();
      template.process(attributes, html);
      return html.toString();
    } catch (Exception failure) {
      throw new IllegalStateException("cannot render login status iframe", failure);
    }
  }

  /** {@code null} = pass; missing/invalid → 401, another client's token or a regular user → 403 */
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
