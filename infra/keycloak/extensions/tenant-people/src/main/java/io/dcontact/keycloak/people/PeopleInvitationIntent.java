package io.dcontact.keycloak.people;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.Immutable;
@Entity @Immutable @Table(name="DC_TENANT_PEOPLE_INVITATION_INTENT")
public class PeopleInvitationIntent {
  @Id @Column(name="ID",length=64) public String id;
  @Column(name="OPERATION_KEY",nullable=false,length=64) public String operationKey;
  @Column(name="GENERATION",nullable=false) public long generation;
  @Column(name="PROVIDER_ATTEMPT_REF",nullable=false,length=36) public String providerAttemptRef;
  @Column(name="REQUEST_DIGEST",nullable=false,length=64) public String requestDigest;
  @Column(name="FENCING_TOKEN",nullable=false) public long fencingToken;
  @Column(name="LEASE_OWNER",nullable=false,length=128) public String leaseOwner;
  @Column(name="NOT_BEFORE_EPOCH",nullable=false) public long notBeforeEpoch;
  @Column(name="CREATED_AT_EPOCH",nullable=false) public long createdAtEpoch;
}
