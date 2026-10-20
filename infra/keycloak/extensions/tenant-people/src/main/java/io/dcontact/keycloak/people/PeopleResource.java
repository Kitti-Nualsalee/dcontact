package io.dcontact.keycloak.people;

import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.userprofile.UserProfileProvider;

@Produces(MediaType.APPLICATION_JSON)
public class PeopleResource {
  private static final Pattern UUID=Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  private static final Set<String> FIELDS=Set.of("tenantId","targetUserId","payloadDigest","fencingToken","email","displayName","role");
  private final KeycloakSession session;
  public PeopleResource(KeycloakSession session) { this.session=session; }
  private record Binding(RealmModel realm,ClientModel client,OrganizationModel organization) {}

  private static Response json(int status,Object value) {
    return Response.status(status).type(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").entity(value).build();
  }
  private static WebApplicationException denied(int status,String code) { return new WebApplicationException(json(status,Map.of("code",code))); }
  private static String text(Map<String,Object> body,String key) {
    Object value=body==null?null:body.get(key);
    if(!(value instanceof String))throw denied(400,"INVALID_REQUEST");
    return (String)value;
  }
  private static void uuid(String value) { if(value==null||!UUID.matcher(value).matches())throw denied(400,"INVALID_REQUEST"); }
  private static String hash(String value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch(Exception failure) { throw new IllegalStateException("digest unavailable"); }
  }
  private Binding authorize(String tenantId) {
    var auth=new AppAuthManager.BearerTokenAuthenticator(session).authenticate();
    if(auth==null)throw denied(401,"UNAUTHORIZED");
    var client=auth.client();var caller=auth.user();var realm=session.getContext().getRealm();
    if(client==null||caller==null||!client.isEnabled()||client.isPublicClient()||!client.isServiceAccountsEnabled()
      ||!client.getId().equals(caller.getServiceAccountClientLink())
      ||!client.getClientId().equals("dcontact-tenant-people-"+tenantId)
      ||!"TENANT_PEOPLE_V1".equals(client.getAttribute("dc_service_purpose"))
      ||!tenantId.equals(client.getAttribute("tenant_id"))
      ||auth.token().getAudience()==null||!Arrays.asList(auth.token().getAudience()).contains("dc-tenant-people"))throw denied(403,"FORBIDDEN");
    ClientModel management=session.clients().getClientByClientId(realm,"realm-management");
    if(management!=null&&management.getRolesStream().anyMatch(caller::hasRole))throw denied(403,"FORBIDDEN");
    if(realm.getRolesStream().filter(role->role.getName().startsWith("platform_")||Set.of("admin","supervisor","agent","create-realm").contains(role.getName())).anyMatch(caller::hasRole))throw denied(403,"FORBIDDEN");
    OrganizationProvider organizations=session.getProvider(OrganizationProvider.class);
    if(organizations==null||!organizations.isEnabled())throw denied(403,"FORBIDDEN");
    var matches=organizations.getAllStream(Map.of("tenant_id",tenantId),0,2).toList();
    if(matches.size()!=1)throw denied(403,"FORBIDDEN");
    var organization=matches.get(0);
    if(!organization.isEnabled()||!organization.getId().equals(client.getAttribute("dc_organization_id"))
      ||!organization.getAlias().equals(client.getAttribute("tenant_slug")))throw denied(403,"FORBIDDEN");
    var profile=session.getProvider(UserProfileProvider.class);
    if(profile==null)throw denied(503,"IDENTITY_PROFILE_NOT_READY");
    var configuration=profile.getConfiguration();
    for(String attribute:List.of("dc_identity_class","tenant_id","tenant_slug","dc_user_id","dc_tenant_people_operation_id")) {
      var field=configuration.getAttribute(attribute);
      if(field==null||field.isMultivalued()||field.getPermissions()==null
        ||!Set.of("admin").equals(field.getPermissions().getEdit())||!Set.of("admin").equals(field.getPermissions().getView()))throw denied(503,"IDENTITY_PROFILE_NOT_READY");
    }
    return new Binding(realm,client,organization);
  }
  private EntityManager entityManager() { return session.getProvider(JpaConnectionProvider.class).getEntityManager(); }
  private String operationKey(Binding binding,String operationId) { return hash(binding.realm().getId()+":"+binding.client().getId()+":"+operationId); }
  private void lockTenant(EntityManager manager,Binding binding,String tenantId) {
    String key=hash(binding.realm().getId()+":"+tenantId);
    manager.createNativeQuery("INSERT INTO DC_TENANT_PEOPLE_GATE(ID,REALM_ID,TENANT_ID) VALUES(:id,:realm,:tenant) ON CONFLICT(ID) DO NOTHING")
      .setParameter("id",key).setParameter("realm",binding.realm().getId()).setParameter("tenant",tenantId).executeUpdate();
    manager.find(TenantGate.class,key,LockModeType.PESSIMISTIC_WRITE);
  }
  private Response receipt(PeopleReceipt receipt) {
    var result=new java.util.HashMap<String,Object>();
    result.put("outcome",receipt.outcome);result.put("receiptRef",receipt.id);result.put("reasonCode",receipt.reasonCode);
    if(receipt.identityId!=null)result.put("identityId",receipt.identityId);
    return json(200,result);
  }

  @GET @Path("readiness")
  public Response readiness(@QueryParam("tenantId") String tenantId) {
    uuid(tenantId);
    Binding binding=authorize(tenantId);
    var allowed=Set.copyOf(Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")));
    if(!allowed.equals(Set.of("AGENT","SUPERVISOR","ADMIN")))throw denied(503,"TENANT_ROLE_NOT_READY");
    for(String role:allowed) {
      var configured=binding.realm().getRole(role.toLowerCase(Locale.ROOT));
      if(configured==null||configured.isComposite())throw denied(503,"TENANT_ROLE_NOT_READY");
    }
    return json(200,Map.of("version",1,"ready",true,"tenantId",tenantId));
  }

  @POST @Path("operations/{operationId}/steps/CREATE_IDENTITY") @Consumes(MediaType.APPLICATION_JSON)
  public Response create(@PathParam("operationId") String operationId,Map<String,Object> body) {
    String tenantId=text(body,"tenantId");uuid(tenantId);
    Binding binding=authorize(tenantId);
    uuid(operationId);
    if(!body.keySet().equals(FIELDS))throw denied(400,"INVALID_REQUEST");
    String target=text(body,"targetUserId"),payloadDigest=text(body,"payloadDigest"),email=text(body,"email"),name=text(body,"displayName"),role=text(body,"role");
    uuid(target);
    if(!payloadDigest.matches("[a-f0-9]{64}")||!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role)
      ||!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(role))throw denied(400,"INVALID_REQUEST");
    if(name.codePointCount(0,name.length())<1||name.codePointCount(0,name.length())>120||Pattern.compile("[\\p{Cc}\\p{Cf}]").matcher(name).find()
      ||!name.equals(name.strip().replaceAll("\\s+"," "))||email.length()>254||!email.matches("[^\\s@\\p{Cc}\\p{Cf}]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z0-9-]+"))throw denied(400,"INVALID_REQUEST");
    if(binding.realm().getRole(role.toLowerCase(Locale.ROOT))==null)throw denied(503,"TENANT_ROLE_NOT_READY");
    long fence;
    try { String supplied=text(body,"fencingToken");if(!supplied.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(supplied); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    EntityManager manager=entityManager();
    lockTenant(manager,binding,tenantId);
    String key=operationKey(binding,operationId),fingerprint=hash(String.join("\n",tenantId,target,payloadDigest,email,name,role,binding.organization().getId()));
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation!=null&&(!operation.requestDigest.equals(fingerprint)||!operation.payloadDigest.equals(payloadDigest)))throw denied(409,"CORRELATION_CONFLICT");
    if(operation!=null&&fence<operation.maxFence)throw denied(409,"STALE_FENCE");
    if(operation==null) {
      operation=new PeopleOperation();operation.id=key;operation.realmId=binding.realm().getId();operation.clientId=binding.client().getId();operation.operationId=operationId;
      operation.tenantId=tenantId;operation.targetUserId=target;operation.payloadDigest=payloadDigest;operation.requestDigest=fingerprint;operation.maxFence=fence;
      manager.persist(operation);
    } else operation.maxFence=fence;
    String receiptId=hash(key+":CREATE_IDENTITY:0");
    PeopleReceipt previous=manager.find(PeopleReceipt.class,receiptId);
    if(previous!=null)return receipt(previous);
    boolean conflict=session.users().getUserById(binding.realm(),target)!=null
      ||session.users().getUserByUsername(binding.realm(),email)!=null||session.users().getUserByEmail(binding.realm(),email)!=null;
    PeopleReceipt result=new PeopleReceipt();result.id=receiptId;result.operationKey=key;result.step="CREATE_IDENTITY";result.generation=0;
    result.outcome=conflict?"REJECTED_NO_EFFECT":"SUCCEEDED";result.reasonCode=conflict?"IDENTITY_CONFLICT":"IDENTITY_CREATED";
    try {
      if(!conflict) {
        UserModel created=session.users().addUser(binding.realm(),target,email,false,false);
        created.setEmail(email);created.setEmailVerified(false);created.setFirstName(name);created.setEnabled(true);
        created.setSingleAttribute("dc_identity_class","TENANT_USER");created.setSingleAttribute("tenant_id",tenantId);
        created.setSingleAttribute("tenant_slug",binding.organization().getAlias());created.setSingleAttribute("dc_user_id",target);
        created.setSingleAttribute("dc_tenant_people_operation_id",operationId);
        for(String required:List.of("VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP"))created.addRequiredAction(required);
        result.identityId=created.getId();
      }
      manager.persist(result);manager.flush();
      return receipt(result);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();
      throw denied(503,"IDENTITY_OUTCOME_UNKNOWN");
    }
  }

  @POST @Path("operations/{operationId}/steps/{step}") @Consumes(MediaType.APPLICATION_JSON)
  public Response configureIdentity(@PathParam("operationId") String operationId,@PathParam("step") String step,Map<String,Object> body) {
    if(!Set.of("TENANT_ROLE","ORG_MEMBERSHIP","VERIFY_MAPPING","VERIFY_PROVISIONED").contains(step))throw denied(400,"INVALID_REQUEST");
    boolean verification=step.startsWith("VERIFY_");
    String tenantId=text(body,"tenantId");uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);
    if(!body.keySet().equals(FIELDS))throw denied(400,"INVALID_REQUEST");
    String target=text(body,"targetUserId"),payloadDigest=text(body,"payloadDigest"),email=text(body,"email"),name=text(body,"displayName"),role=text(body,"role");
    uuid(target);
    if(!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role)
      ||!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(role))throw denied(400,"INVALID_REQUEST");
    long fence;
    try { String supplied=text(body,"fencingToken");if(!supplied.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(supplied); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    EntityManager manager=entityManager();lockTenant(manager,binding,tenantId);
    String key=operationKey(binding,operationId),fingerprint=hash(String.join("\n",tenantId,target,payloadDigest,email,name,role,binding.organization().getId()));
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)throw denied(409,"CREATE_IDENTITY_REQUIRED");
    if(!operation.requestDigest.equals(fingerprint)||!operation.payloadDigest.equals(payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    if(fence<operation.maxFence)throw denied(409,"STALE_FENCE");
    operation.maxFence=fence;
    String receiptId=hash(key+":"+step+":0");PeopleReceipt previous=manager.find(PeopleReceipt.class,receiptId);
    if(previous!=null&&!verification)return receipt(previous);
    PeopleReceipt created=manager.find(PeopleReceipt.class,hash(key+":CREATE_IDENTITY:0"));
    if(created==null||!"SUCCEEDED".equals(created.outcome)||!target.equals(created.identityId))throw denied(409,"CREATE_IDENTITY_REQUIRED");
    if(!"TENANT_ROLE".equals(step)) {
      PeopleReceipt granted=manager.find(PeopleReceipt.class,hash(key+":TENANT_ROLE:0"));
      if(granted==null||!"SUCCEEDED".equals(granted.outcome)||!target.equals(granted.identityId))throw denied(409,"TENANT_ROLE_REQUIRED");
    }
    if(verification) {
      PeopleReceipt joined=manager.find(PeopleReceipt.class,hash(key+":ORG_MEMBERSHIP:0"));
      if(joined==null||!"SUCCEEDED".equals(joined.outcome)||!target.equals(joined.identityId))throw denied(409,"ORGANIZATION_MEMBERSHIP_REQUIRED");
      if("VERIFY_PROVISIONED".equals(step)) {
        PeopleReceipt verified=manager.find(PeopleReceipt.class,hash(key+":VERIFY_MAPPING:0"));
        if(verified==null||!"SUCCEEDED".equals(verified.outcome)||!target.equals(verified.identityId))throw denied(409,"IDENTITY_MAPPING_REQUIRED");
      }
    }
    UserModel user=session.users().getUserById(binding.realm(),target);
    var desired=binding.realm().getRole(role.toLowerCase(Locale.ROOT));
    if(desired==null||desired.isComposite())throw denied(503,"TENANT_ROLE_NOT_READY");
    if(user==null||user.getServiceAccountClientLink()!=null||!user.isEnabled()
      ||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getUsername())||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getEmail())
      ||!"TENANT_USER".equals(user.getFirstAttribute("dc_identity_class"))
      ||!tenantId.equals(user.getFirstAttribute("tenant_id"))||!target.equals(user.getFirstAttribute("dc_user_id"))
      ||!binding.organization().getAlias().equals(user.getFirstAttribute("tenant_slug"))
      ||!operationId.equals(user.getFirstAttribute("dc_tenant_people_operation_id")))throw denied(409,"IDENTITY_MAPPING_CONFLICT");
    if(user.getRoleMappingsStream().anyMatch(mapped->!mapped.getId().equals(desired.getId())))throw denied(409,"IDENTITY_ROLE_CONFLICT");
    if(!"TENANT_ROLE".equals(step)&&!user.hasRole(desired))throw denied(409,"IDENTITY_ROLE_CONFLICT");
    var memberships=session.getProvider(OrganizationProvider.class).getByMember(user).toList();
    if(memberships.size()>1||memberships.stream().anyMatch(organization->!organization.getId().equals(binding.organization().getId())))throw denied(409,"IDENTITY_ORGANIZATION_CONFLICT");
    if(verification) {
      if(memberships.size()!=1||user.isEmailVerified()||user.credentialManager().getStoredCredentialsStream().findAny().isPresent()
        ||!Set.of("VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP").equals(user.getRequiredActionsStream().collect(java.util.stream.Collectors.toSet())))throw denied(409,"IDENTITY_ACTIVATION_CONFLICT");
      if(previous!=null)return receipt(previous);
    }
    try {
      if("TENANT_ROLE".equals(step))user.grantRole(desired);
      else if("ORG_MEMBERSHIP".equals(step)&&memberships.isEmpty()) {
        var organizations=session.getProvider(OrganizationProvider.class);
        if(!organizations.addMember(binding.organization(),user))throw new IllegalStateException("membership not added");
      }
      PeopleReceipt result=new PeopleReceipt();result.id=receiptId;result.operationKey=key;result.step=step;result.generation=0;
      result.outcome="SUCCEEDED";result.reasonCode=verification?"IDENTITY_VERIFIED":("TENANT_ROLE".equals(step)?"TENANT_ROLE_GRANTED":"ORGANIZATION_JOINED");result.identityId=target;
      manager.persist(result);manager.flush();return receipt(result);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();throw denied(503,"IDENTITY_OUTCOME_UNKNOWN");
    }
  }

  @GET @Path("operations/{operationId}/steps/{step}")
  public Response read(@PathParam("operationId") String operationId,@PathParam("step") String step,@QueryParam("tenantId") String tenantId,@QueryParam("targetUserId") String target,@QueryParam("payloadDigest") String payloadDigest) {
    if(!Set.of("CREATE_IDENTITY","TENANT_ROLE","ORG_MEMBERSHIP","VERIFY_MAPPING","VERIFY_PROVISIONED").contains(step))throw denied(400,"INVALID_REQUEST");
    uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);uuid(target);
    if(payloadDigest==null||!payloadDigest.matches("[a-f0-9]{64}"))throw denied(400,"INVALID_REQUEST");
    EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)return json(200,Map.of("outcome","UNKNOWN"));
    if(!operation.tenantId.equals(tenantId)||!operation.targetUserId.equals(target)||!operation.payloadDigest.equals(payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    PeopleReceipt result=manager.find(PeopleReceipt.class,hash(key+":"+step+":0"));
    return result==null?json(200,Map.of("outcome","UNKNOWN")):receipt(result);
  }
}
