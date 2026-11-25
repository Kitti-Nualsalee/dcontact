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
 * AC6 (#599): customers manage their account in D-Contact only (#589) — opening {@code /realms/dcontact/account/} sends them to D-Contact Console
 *
 * <p>The destination is the {@code baseUrl} of the client {@code account-console}, which {@code pnpm infra:identity:branding}
 * sets from {@code CONSOLE_PUBLIC_URL} (no URL is embedded in the extension). If it is not set or not an absolute URL, answer 404 —
 * never redirect back to the same path and never show the identity provider's page
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
