package io.dcontact.keycloak.people;

import jakarta.ws.rs.HeaderParam;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.core.Response;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import org.keycloak.Config;
import org.keycloak.common.util.Time;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

public class BoundaryClockFactory implements RealmResourceProviderFactory {
  public String getId() { return "dc-boundary-clock"; }
  public void init(Config.Scope configuration) {}
  public void postInit(KeycloakSessionFactory factory) {}
  public void close() { Time.setOffset(0); }
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      public Object getResource() { return new ClockResource(session); }
      public void close() {}
    };
  }
  public static class ClockResource {
    private final KeycloakSession session;
    public ClockResource(KeycloakSession session) { this.session=session; }
    @POST @Path("{offset}")
    public Response offset(@PathParam("offset") int offset,@HeaderParam("X-Boundary-Clock") String supplied) {
      String expected=System.getenv("B3_BOUNDARY_CLOCK_SECRET");
      if(!"master".equals(session.getContext().getRealm().getName())||expected==null||supplied==null
        ||!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),supplied.getBytes(StandardCharsets.UTF_8)))return Response.status(403).build();
      if(offset<0||offset>604800)return Response.status(400).build();
      Time.setOffset(offset);
      return Response.ok(Map.of("offset",offset,"epoch",Time.currentTimeSeconds())).type("application/json").build();
    }
  }
}
