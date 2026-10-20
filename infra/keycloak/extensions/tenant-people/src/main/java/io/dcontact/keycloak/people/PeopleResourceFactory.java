package io.dcontact.keycloak.people;
import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;
public class PeopleResourceFactory implements RealmResourceProviderFactory {
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      public Object getResource() { return new PeopleResource(session); }
      public void close() {}
    };
  }
  public String getId() { return "dc-tenant-people"; }
  public void init(Config.Scope config) {}
  public void postInit(KeycloakSessionFactory factory) {}
  public void close() {}
}
