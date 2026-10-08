package io.dcontact.keycloak.account;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.NotFoundException;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.core.Response;
import java.net.URI;
import java.util.regex.Pattern;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;

/**
 * AC6 (#599): ลูกค้าจัดการบัญชีใน D-Contact เท่านั้น (#589) — เปิด {@code /realms/dcontact/account/} แล้วไป D-Contact Console
 *
 * <p>ปลายทางคือ {@code baseUrl} ของ client {@code account-console} ที่ {@code pnpm infra:identity:branding}
 * ตั้งจาก {@code CONSOLE_PUBLIC_URL} (ไม่ฝัง URL ใน extension) ถ้ายังไม่ตั้ง/ไม่ใช่ URL สัมบูรณ์ ตอบ 404 —
 * ไม่ redirect วนกลับมาที่ path เดิม และไม่แสดงหน้าของ identity provider
 */
public class DcAccountLanding {

  static final String CONSOLE_CLIENT = "account-console";
  private static final Pattern ABSOLUTE_HTTP = Pattern.compile("^https?://[^\\s]+$");

  private final KeycloakSession session;

  public DcAccountLanding(KeycloakSession session) {
    this.session = session;
  }

  @GET
  public Response root() {
    return redirect();
  }

  @GET
  @Path("{path: .+}")
  public Response any() {
    return redirect();
  }

  private Response redirect() {
    ClientModel client = session.getContext().getRealm().getClientByClientId(CONSOLE_CLIENT);
    String target = client == null ? null : client.getBaseUrl();
    if (target == null || !ABSOLUTE_HTTP.matcher(target).matches()) throw new NotFoundException();
    return Response.status(302).location(URI.create(target)).header("Cache-Control", "no-store").build();
  }
}
