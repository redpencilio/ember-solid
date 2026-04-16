import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import Service from '@ember/service';
import { later } from '@ember/runloop';
import { sym } from 'rdflib';
import { getDefaultSession } from '@inrupt/solid-client-authn-browser';

import { LDP, RDF, SOLID, SP } from 'ember-solid/utils/namespaces';
import env from 'ember-get-config';


/**
 *
 * Ember service used to log-in with solid and fetch profile-info and type-indexes
 *
 * @class AuthService
 *
 * @property {Session} session A solid session
 * @property {StoreService} store Rdf-store used to query data from solid
 */
export default class AuthService extends Service {
  @tracked
  session = null;

  @tracked _writeCache = {};

  get isLoggedIn() {
    const session = this.session;
    return session?.info?.isLoggedIn;
  }
  solidLastIdentityProviderKey = "solid-last-identity-provider";
  solidAuthRedirectPathKey = "solid-auth-redirect-path";

  @service(env.rdfStore.name)
  store;

  @service
  router;

  async restoreSession() {
    if (this.session) {
      return this.session;
    } else {
      const session = getDefaultSession();

      try {
        const redirectPath = window.localStorage.getItem(this.solidAuthRedirectPathKey);
        if( !redirectPath )
          window.localStorage.setItem(this.solidAuthRedirectPathKey, window.location.href);

        // restorePreviousSession: true re-authenticates silently from stored
        // localStorage tokens on normal page loads. Disabled on the OAuth
        // callback (URL contains ?code=) because handleIncomingRedirect already
        // processes the code — passing restorePreviousSession:true there would
        // start a competing silent auth with no redirectUrl.
        const isCallback = new URL(window.location.href).searchParams.has('code');
        const incomingRedirectResponse = await session.handleIncomingRedirect({ restorePreviousSession: !isCallback, url: window.location.href });
        this.store.authSession = session;
        this.store.podBase = await this.getPodBase(session.info.webId);

        window.localStorage.removeItem(this.solidAuthRedirectPathKey);
        if( redirectPath ) {
          const url = new URL(redirectPath);
          // Use the raw URL path for in-app navigation rather than
          // router.recognize() + router.replaceWith(name, params).
          // Two reasons:
          // 1. recognize() returns already-encoded params; passing them back to
          //    replaceWith(name, params) double-encodes them (%2F → %252F),
          //    breaking routes whose dynamic segments contain URL-encoded slashes.
          // 2. In-app navigation (replaceWith) does NOT reload the page, so
          //    ApplicationRoute.beforeModel() is not re-run. This prevents the
          //    @inrupt/solid-client-authn-browser silentlyAuthenticate() cycle
          //    from re-triggering on every navigation and causing a redirect loop.
          const path = this.router.location.implementation === 'hash'
            ? url.hash.slice(1)
            : url.pathname + url.search + url.hash;
          later(() => this.router.replaceWith(path), 0);
        }
      } catch (e) {
        console.warn('[solid-auth] restoreSession catch:', e?.message ?? e);
        await session.logout();
      }

      this.session = session;
      return this.session;
    }
  }

  @service
  router

  /**
   *
   * Logs in to a solid-pod with a given provider
   *
   * @param {String} identityProvider The solid-provider to login with
   *
   * @method ensureLogin
   */
  async ensureLogin({identityProvider = null, clientName = "Ember Solid!", redirectUrl = window.location.href } = {}) {
    const session = await this.restoreSession();
    const isLoggedIn = session.info?.isLoggedIn;

    if( !isLoggedIn ) {
      if (identityProvider)
        window.localStorage.setItem(this.solidLastIdentityProviderKey, identityProvider);
      else
        identityProvider = window.localStorage.getItem(this.solidLastIdentityProviderKey);

      redirectUrl = redirectUrl || window.location.href;

      window.localStorage.setItem(this.solidAuthRedirectPathKey, redirectUrl);

      if (!identityProvider)
        this.router.transitionTo("login", { queryParams: { from: redirectUrl } });

      await session.login({
        oidcIssuer: identityProvider,
        redirectUrl,
        clientName
      });

      // this.session = session;
      this.store.authSession = session;
      this.store.podBase = await this.getPodBase(session.info.webId);
    }
  }

  /**
   * Logs out of the current solid-pod.
   *
   * @method ensureLogout
   */
  async ensureLogout(){
    const session = await this.restoreSession();
    const isLoggedIn = session.info?.isLoggedIn;
    if( isLoggedIn ) {
      await session.logout();
    }
    window.localStorage.removeItem(this.solidLastIdentityProviderKey);
    this._writeCache = {};
  }

  /**
   * Check whether the current user has write access to a Solid resource
   * by inspecting its WAC ACL document.
   *
   * Strategy:
   * 1. HEAD the resource — if the response includes a Link: <…>; rel="acl"
   *    header, fetch that ACL document.
   * 2. Parse the Turtle for acl:Write associated with the current WebID.
   * 3. Fallback: if HEAD succeeds but no ACL link header is present,
   *    assume the user has write access (e.g. unprotected dev server).
   *
   * Results are cached per URL for the lifetime of the service instance.
   *
   * @param {string} resourceUrl
   * @returns {Promise<boolean>}
   */
  async canWrite(resourceUrl) {
    if (!this.isLoggedIn) return false;
    if (this._writeCache[resourceUrl] !== undefined) {
      return this._writeCache[resourceUrl];
    }

    try {
      const authFetch = this.session?.fetch?.bind(this.session) || fetch;
      const res = await authFetch(resourceUrl, { method: 'HEAD' });

      if (!res.ok) {
        this._writeCache[resourceUrl] = false;
        return false;
      }

      const linkHeader = res.headers.get('Link') || '';
      const aclMatch = linkHeader.match(/<([^>]+)>;\s*rel="acl"/);

      if (!aclMatch) {
        // No WAC ACL header — assume write if we can HEAD successfully
        this._writeCache[resourceUrl] = true;
        return true;
      }

      const aclUrl = aclMatch[1];
      const aclRes = await authFetch(aclUrl, { headers: { Accept: 'text/turtle' } });

      if (!aclRes.ok) {
        this._writeCache[resourceUrl] = false;
        return false;
      }

      const turtle = await aclRes.text();
      const hasWrite = this._parseTurtleForWriteAccess(turtle, this.webId);
      this._writeCache[resourceUrl] = hasWrite;
      return hasWrite;
    } catch {
      this._writeCache[resourceUrl] = false;
      return false;
    }
  }

  /**
   * Naive WAC Turtle check: look for acl:Write in the same block as the WebID.
   * Covers the common single-owner case without a full WAC parser.
   * @private
   */
  _parseTurtleForWriteAccess(turtle, webId) {
    if (!webId) return false;
    const hasWebId = turtle.includes(webId);
    const hasWrite = /acl:Write|acl:mode\s+acl:Write/.test(turtle);
    return hasWebId && hasWrite;
  }

  /**
   *
   * Fetches profile-info and the private- and public type indexes
   *
   * @method ensureTypeIndex
   */
  async ensureTypeIndex() {
    await this.store.load(this.webIdSym.doc());

    const privateTypeIndex = this.privateTypeIndexLocation;
    this.store.privateTypeIndex = privateTypeIndex;
    await this.store.load(privateTypeIndex);

    const publicTypeIndex = this.publicTypeIndexLocation;
    this.store.publicTypeIndex = publicTypeIndex;
    await this.store.load(publicTypeIndex);
  }

  get privateTypeIndexLocation() {
    return this.store.any(this.webIdSym, SOLID("privateTypeIndex"), undefined, this.webIdSym.doc())
      || sym(`${this.podBase}/settings}/privateTypeIndex`);
  }

  get publicTypeIndexLocation() {
    return this.store.any(this.webIdSym, SOLID("publicTypeIndex"), undefined, this.webIdSym.doc())
      || sym(`${this.podBase}/settings}/publicTypeIndex`);
  }

  get webId() {
    return this.session?.info?.webId;
  }

  get webIdSym() {
    return sym(this.webId);
  }

  /**
   * Gets the pod base of the current user as a Promise.
   * Will always end with a trailing slash.
   *
   * First, it will look for a pim:storage property on the webId.
   * If not, it will look if the current queried resource is a pim:Storage resource, which is then our podBase.
   * If not, it will look if the current queried resource is a lpd:BasicContainer resource, which is then our podBase.
   * Otherwise, it will traverse upwards and do the same again.
   *
   * @returns {Promise<string>}
   */
  get podBase() {
    return this.getPodBase(this.webId);
  }

  async getPodBase(webId) {
    let podBase = undefined;
    let webIdDoc = webId;
    if (webId) {
      await this.store.load(sym(webId).doc());
      podBase = this.store.any(sym(webId), SP('storage'), undefined, sym(webIdDoc).doc())?.value || this.store.any(undefined, RDF('type'), SP('Storage'), sym(webIdDoc).doc())?.value;
      // Check if podBase is not undefined and webIdDoc is not the root domain
      let previousWebIdDoc = webIdDoc;
      while (!podBase && !this.store.any(webIdDoc, RDF('type'), LDP('BasicContainer'), sym(webIdDoc).doc()) && !webIdDoc.endsWith('://')) {
        // Substring of webIdDoc leaving off the last slash and last directory.
        previousWebIdDoc = webIdDoc;
        webIdDoc = webIdDoc.substring(0, webIdDoc.lastIndexOf('/', webIdDoc.length - 2)) + '/';
        podBase = this.store.any(sym(webIdDoc), SP('storage'), undefined, sym(webIdDoc).doc())?.value || this.store.any(undefined, RDF('type'), SP('Storage'), sym(webIdDoc).doc())?.value;
      }

      if (!podBase) {
        podBase = previousWebIdDoc;
      }
      if (!podBase.endsWith('/')) {
        podBase += '/';
      }
    } else {
      console.log('No webId');
    }
    return podBase;
  }
}
