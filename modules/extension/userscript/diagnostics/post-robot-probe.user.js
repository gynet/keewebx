// ==UserScript==
// @name         KeeWebX post-robot connection test
// @namespace    https://keewebx.app/
// @version      0.2.1
// @description  Test cross-origin replies from the original KeeWebX tab using bundled post-robot 11.0.1. No database/password access.
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @grant        none
// ==/UserScript==

// Includes @krakenjs/post-robot 11.0.1, Apache-2.0.
// Source: https://github.com/krakenjs/post-robot
// License: https://github.com/krakenjs/post-robot/blob/main/LICENSE
// Distribution SHA-256: 7cc512fa9e25f4abcc30b199bcf96c6bc9683fd32d62db9f72c06a52fc50ff54

/*! @krakenjs/post-robot 11.0.1 license:
                               Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2016 PayPal

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

*/
(() => {
const module = { exports: {} };
const exports = module.exports;
!function(n,e){"object"==typeof exports&&"object"==typeof module?module.exports=e():"function"==typeof define&&define.amd?define("postRobot",[],e):"object"==typeof exports?exports.postRobot=e():n.postRobot=e()}("undefined"!=typeof self?self:this,(function(){return function(n){var e={};function t(r){if(e[r])return e[r].exports;var o=e[r]={i:r,l:!1,exports:{}};return n[r].call(o.exports,o,o.exports,t),o.l=!0,o.exports}return t.m=n,t.c=e,t.d=function(n,e,r){t.o(n,e)||Object.defineProperty(n,e,{enumerable:!0,get:r})},t.r=function(n){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(n,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(n,"__esModule",{value:!0})},t.t=function(n,e){if(1&e&&(n=t(n)),8&e)return n;if(4&e&&"object"==typeof n&&n&&n.__esModule)return n;var r=Object.create(null);if(t.r(r),Object.defineProperty(r,"default",{enumerable:!0,value:n}),2&e&&"string"!=typeof n)for(var o in n)t.d(r,o,function(e){return n[e]}.bind(null,o));return r},t.n=function(n){var e=n&&n.__esModule?function(){return n.default}:function(){return n};return t.d(e,"a",e),e},t.o=function(n,e){return{}.hasOwnProperty.call(n,e)},t.p="",t(t.s=0)}([function(n,e,t){"use strict";function r(n){return"[object RegExp]"==={}.toString.call(n)}t.r(e),t.d(e,"Promise",(function(){return z})),t.d(e,"TYPES",(function(){return te})),t.d(e,"ProxyWindow",(function(){return Cn})),t.d(e,"setup",(function(){return ne})),t.d(e,"destroy",(function(){return ee})),t.d(e,"serializeMessage",(function(){return Gn})),t.d(e,"deserializeMessage",(function(){return Qn})),t.d(e,"createProxyWindow",(function(){return Vn})),t.d(e,"toProxyWindow",(function(){return Xn})),t.d(e,"on",(function(){return Yn})),t.d(e,"once",(function(){return Zn})),t.d(e,"send",(function(){return $n})),t.d(e,"markWindowKnown",(function(){return En})),t.d(e,"cleanUpWindow",(function(){return re})),t.d(e,"bridge",(function(){}));var o="Call was rejected by callee.\r\n";function i(n){return void 0===n&&(n=window),n.location.protocol}function u(n){if(void 0===n&&(n=window),n.mockDomain){var e=n.mockDomain.split("//")[0];if(e)return e}return i(n)}function a(n){return void 0===n&&(n=window),"about:"===u(n)}function c(n){if(void 0===n&&(n=window),n)try{if(n.parent&&n.parent!==n)return n.parent}catch(n){}}function s(n){if(void 0===n&&(n=window),n&&!c(n))try{return n.opener}catch(n){}}function f(n){try{return!0}catch(n){}return!1}function d(n){void 0===n&&(n=window);var e=n.location;if(!e)throw new Error("Can not read window location");var t=i(n);if(!t)throw new Error("Can not read window protocol");if("file:"===t)return"file://";if("about:"===t){var r=c(n);return r&&f()?d(r):"about://"}var o=e.host;if(!o)throw new Error("Can not read window host");return t+"//"+o}function l(n){void 0===n&&(n=window);var e=d(n);return e&&n.mockDomain&&0===n.mockDomain.indexOf("mock:")?n.mockDomain:e}function h(n){if(!function(n){try{if(n===window)return!0}catch(n){}try{var e=Object.getOwnPropertyDescriptor(n,"location");if(e&&!1===e.enumerable)return!1}catch(n){}try{if(a(n)&&f())return!0}catch(n){}try{if(function(n){return void 0===n&&(n=window),"mock:"===u(n)}(n)&&f())return!0}catch(n){}try{if(d(n)===d(window))return!0}catch(n){}return!1}(n))return!1;try{if(n===window)return!0;if(a(n)&&f())return!0;if(l(window)===l(n))return!0}catch(n){}return!1}function w(n){if(!h(n))throw new Error("Expected window to be same domain");return n}function p(n,e){if(!n||!e)return!1;var t=c(e);return t?t===n:-1!==function(n){var e=[];try{for(;n.parent!==n;)e.push(n.parent),n=n.parent}catch(n){}return e}(e).indexOf(n)}function v(n){var e,t,r=[];try{e=n.frames}catch(t){e=n}try{t=e.length}catch(n){}if(0===t)return r;if(t){for(var o=0;o<t;o++){var i=void 0;try{i=e[o]}catch(n){continue}r.push(i)}return r}for(var u=0;u<100;u++){var a=void 0;try{a=e[u]}catch(n){return r}if(!a)return r;r.push(a)}return r}var m=[],y=[];function g(n,e){void 0===e&&(e=!0);try{if(n===window)return!1}catch(n){return!0}try{if(!n)return!0}catch(n){return!0}try{if(n.closed)return!0}catch(n){return!n||n.message!==o}if(e&&h(n))try{if(n.mockclosed)return!0}catch(n){}try{if(!n.parent||!n.top)return!0}catch(n){}var t=function(n,e){for(var t=0;t<n.length;t++)try{if(n[t]===e)return t}catch(n){}return-1}(m,n);if(-1!==t){var r=y[t];if(r&&function(n){if(!n.contentWindow)return!0;if(!n.parentNode)return!0;var e=n.ownerDocument;if(e&&e.documentElement&&!e.documentElement.contains(n)){for(var t=n;t.parentNode&&t.parentNode!==t;)t=t.parentNode;if(!t.host||!e.documentElement.contains(t.host))return!0}return!1}(r))return!0}return!1}function _(n){return void 0===n&&(n=window),s(n=n||window)||c(n)||void 0}function b(n,e){if("string"==typeof n){if("string"==typeof e)return"*"===n||e===n;if(r(e))return!1;if(Array.isArray(e))return!1}return r(n)?r(e)?n.toString()===e.toString():!Array.isArray(e)&&Boolean(e.match(n)):!!Array.isArray(n)&&(Array.isArray(e)?JSON.stringify(n)===JSON.stringify(e):!r(e)&&n.some((function(n){return b(n,e)})))}function W(n){try{if(n===window)return!0}catch(n){if(n&&n.message===o)return!0}try{if("[object Window]"==={}.toString.call(n))return!0}catch(n){if(n&&n.message===o)return!0}try{if(window.Window&&n instanceof window.Window)return!0}catch(n){if(n&&n.message===o)return!0}try{if(n&&n.self===n)return!0}catch(n){if(n&&n.message===o)return!0}try{if(n&&n.parent===n)return!0}catch(n){if(n&&n.message===o)return!0}try{if(n&&n.top===n)return!0}catch(n){if(n&&n.message===o)return!0}try{if(n&&"__unlikely_value__"===n.__cross_domain_utils_window_check__)return!1}catch(n){return!0}try{if("postMessage"in n&&"self"in n&&"location"in n)return!0}catch(n){}return!1}function E(n){if(h(n))return w(n).frameElement;for(var e=0,t=document.querySelectorAll("iframe");e<t.length;e++){var r=t[e];if(r&&r.contentWindow&&r.contentWindow===n)return r}}function x(n){if(function(n){return void 0===n&&(n=window),Boolean(c(n))}(n)){var e=E(n);if(e&&e.parentElement)return void e.parentElement.removeChild(e)}try{n.close()}catch(n){}}function j(n){try{if(!n)return!1;if("undefined"!=typeof Promise&&n instanceof Promise)return!0;if("undefined"!=typeof window&&"function"==typeof window.Window&&n instanceof window.Window)return!1;if("undefined"!=typeof window&&"function"==typeof window.constructor&&n instanceof window.constructor)return!1;var e={}.toString;if(e){var t=e.call(n);if("[object Window]"===t||"[object global]"===t||"[object DOMWindow]"===t)return!1}if("function"==typeof n.then)return!0}catch(n){return!1}return!1}var S,k=[],O=[],P=0;function A(){if(!P&&S){var n=S;S=null,n.resolve()}}function D(){P+=1}function I(){P-=1,A()}var z=function(){function n(n){var e=this;if(this.resolved=void 0,this.rejected=void 0,this.errorHandled=void 0,this.value=void 0,this.error=void 0,this.handlers=void 0,this.dispatching=void 0,this.stack=void 0,this.resolved=!1,this.rejected=!1,this.errorHandled=!1,this.handlers=[],n){var t,r,o=!1,i=!1,u=!1;D();try{n((function(n){u?e.resolve(n):(o=!0,t=n)}),(function(n){u?e.reject(n):(i=!0,r=n)}))}catch(n){return I(),void this.reject(n)}I(),u=!0,o?this.resolve(t):i&&this.reject(r)}}var e=n.prototype;return e.resolve=function(n){if(this.resolved||this.rejected)return this;if(j(n))throw new Error("Can not resolve promise with another promise");return this.resolved=!0,this.value=n,this.dispatch(),this},e.reject=function(n){var e=this;if(this.resolved||this.rejected)return this;if(j(n))throw new Error("Can not reject promise with another promise");if(!n){var t=n&&"function"==typeof n.toString?n.toString():{}.toString.call(n);n=new Error("Expected reject to be called with Error, got "+t)}return this.rejected=!0,this.error=n,this.errorHandled||setTimeout((function(){e.errorHandled||function(n,e){if(-1===k.indexOf(n)){k.push(n),setTimeout((function(){throw n}),1);for(var t=0;t<O.length;t++)O[t](n,e)}}(n,e)}),1),this.dispatch(),this},e.asyncReject=function(n){return this.errorHandled=!0,this.reject(n),this},e.dispatch=function(){var e=this.resolved,t=this.rejected,r=this.handlers;if(!this.dispatching&&(e||t)){this.dispatching=!0,D();for(var o=function(n,e){return n.then((function(n){e.resolve(n)}),(function(n){e.reject(n)}))},i=0;i<r.length;i++){var u=r[i],a=u.onSuccess,c=u.onError,s=u.promise,f=void 0;if(e)try{f=a?a(this.value):this.value}catch(n){s.reject(n);continue}else if(t){if(!c){s.reject(this.error);continue}try{f=c(this.error)}catch(n){s.reject(n);continue}}if(f instanceof n&&(f.resolved||f.rejected)){var d=f;d.resolved?s.resolve(d.value):s.reject(d.error),d.errorHandled=!0}else j(f)?f instanceof n&&(f.resolved||f.rejected)?f.resolved?s.resolve(f.value):s.reject(f.error):o(f,s):s.resolve(f)}r.length=0,this.dispatching=!1,I()}},e.then=function(e,t){if(e&&"function"!=typeof e&&!e.call)throw new Error("Promise.then expected a function for success handler");if(t&&"function"!=typeof t&&!t.call)throw new Error("Promise.then expected a function for error handler");var r=new n;return this.handlers.push({promise:r,onSuccess:e,onError:t}),this.errorHandled=!0,this.dispatch(),r},e.catch=function(n){return this.then(void 0,n)},e.finally=function(e){if(e&&"function"!=typeof e&&!e.call)throw new Error("Promise.finally expected a function");return this.then((function(t){return n.try(e).then((function(){return t}))}),(function(t){return n.try(e).then((function(){throw t}))}))},e.timeout=function(n,e){var t=this;if(this.resolved||this.rejected)return this;var r=setTimeout((function(){t.resolved||t.rejected||t.reject(e||new Error("Promise timed out after "+n+"ms"))}),n);return this.then((function(n){return clearTimeout(r),n}))},e.toPromise=function(){if("undefined"==typeof Promise)throw new TypeError("Could not find Promise");return Promise.resolve(this)},e.lazy=function(){return this.errorHandled=!0,this},n.resolve=function(e){return e instanceof n?e:j(e)?new n((function(n,t){return e.then(n,t)})):(new n).resolve(e)},n.reject=function(e){return(new n).reject(e)},n.asyncReject=function(e){return(new n).asyncReject(e)},n.all=function(e){var t=new n,r=e.length,o=[].slice();if(!r)return t.resolve(o),t;for(var i=function(n,e,i){return e.then((function(e){o[n]=e,0==(r-=1)&&t.resolve(o)}),(function(n){i.reject(n)}))},u=0;u<e.length;u++){var a=e[u];if(a instanceof n){if(a.resolved){o[u]=a.value,r-=1;continue}}else if(!j(a)){o[u]=a,r-=1;continue}i(u,n.resolve(a),t)}return 0===r&&t.resolve(o),t},n.hash=function(e){var t={},r=[],o=function(n){if(e.hasOwnProperty(n)){var o=e[n];j(o)?r.push(o.then((function(e){t[n]=e}))):t[n]=o}};for(var i in e)o(i);return n.all(r).then((function(){return t}))},n.map=function(e,t){return n.all(e.map(t))},n.onPossiblyUnhandledException=function(n){return function(n){return O.push(n),{cancel:function(){O.splice(O.indexOf(n),1)}}}(n)},n.try=function(e,t,r){if(e&&"function"!=typeof e&&!e.call)throw new Error("Promise.try expected a function");var o;D();try{o=e.apply(t,r||[])}catch(e){return I(),n.reject(e)}return I(),n.resolve(o)},n.delay=function(e){return new n((function(n){setTimeout(n,e)}))},n.isPromise=function(e){return!!(e&&e instanceof n)||j(e)},n.flush=function(){return e=S=S||new n,A(),e;var e},n}();function C(n,e){return(C=Object.setPrototypeOf||function(n,e){return n.__proto__=e,n})(n,e)}function M(n,e){n.prototype=Object.create(e.prototype),n.prototype.constructor=n,C(n,e)}function N(n,e){for(var t=0;t<n.length;t++)try{if(n[t]===e)return t}catch(n){}return-1}var R,T=function(){function n(){if(this.name=void 0,this.weakmap=void 0,this.keys=void 0,this.values=void 0,this.name="__weakmap_"+(1e9*Math.random()>>>0)+"__",function(){if("undefined"==typeof WeakMap)return!1;if(void 0===Object.freeze)return!1;try{var n=new WeakMap,e={};return Object.freeze(e),n.set(e,"__testvalue__"),"__testvalue__"===n.get(e)}catch(n){return!1}}())try{this.weakmap=new WeakMap}catch(n){}this.keys=[],this.values=[]}var e=n.prototype;return e._cleanupClosedWindows=function(){for(var n=this.weakmap,e=this.keys,t=0;t<e.length;t++){var r=e[t];if(W(r)&&g(r)){if(n)try{n.delete(r)}catch(n){}e.splice(t,1),this.values.splice(t,1),t-=1}}},e.isSafeToReadWrite=function(n){return!W(n)},e.set=function(n,e){if(!n)throw new Error("WeakMap expected key");var t=this.weakmap;if(t)try{t.set(n,e)}catch(n){delete this.weakmap}if(this.isSafeToReadWrite(n))try{var r=this.name,o=n[r];return void(o&&o[0]===n?o[1]=e:Object.defineProperty(n,r,{value:[n,e],writable:!0}))}catch(n){}this._cleanupClosedWindows();var i=this.keys,u=this.values,a=N(i,n);-1===a?(i.push(n),u.push(e)):u[a]=e},e.get=function(n){if(!n)throw new Error("WeakMap expected key");var e=this.weakmap;if(e)try{if(e.has(n))return e.get(n)}catch(n){delete this.weakmap}if(this.isSafeToReadWrite(n))try{var t=n[this.name];return t&&t[0]===n?t[1]:void 0}catch(n){}this._cleanupClosedWindows();var r=N(this.keys,n);if(-1!==r)return this.values[r]},e.delete=function(n){if(!n)throw new Error("WeakMap expected key");var e=this.weakmap;if(e)try{e.delete(n)}catch(n){delete this.weakmap}if(this.isSafeToReadWrite(n))try{var t=n[this.name];t&&t[0]===n&&(t[0]=t[1]=void 0)}catch(n){}this._cleanupClosedWindows();var r=this.keys,o=N(r,n);-1!==o&&(r.splice(o,1),this.values.splice(o,1))},e.has=function(n){if(!n)throw new Error("WeakMap expected key");var e=this.weakmap;if(e)try{if(e.has(n))return!0}catch(n){delete this.weakmap}if(this.isSafeToReadWrite(n))try{var t=n[this.name];return!(!t||t[0]!==n)}catch(n){}return this._cleanupClosedWindows(),-1!==N(this.keys,n)},e.getOrSet=function(n,e){if(this.has(n))return this.get(n);var t=e();return this.set(n,t),t},n}();function L(n){return(L=Object.setPrototypeOf?Object.getPrototypeOf:function(n){return n.__proto__||Object.getPrototypeOf(n)})(n)}function q(){if("undefined"==typeof Reflect||!Reflect.construct)return!1;if(Reflect.construct.sham)return!1;if("function"==typeof Proxy)return!0;try{return Date.prototype.toString.call(Reflect.construct(Date,[],(function(){}))),!0}catch(n){return!1}}function F(n,e,t){return(F=q()?Reflect.construct:function(n,e,t){var r=[null];r.push.apply(r,e);var o=new(Function.bind.apply(n,r));return t&&C(o,t.prototype),o}).apply(null,arguments)}function B(n){var e="function"==typeof Map?new Map:void 0;return(B=function(n){if(null===n||-1===Function.toString.call(n).indexOf("[native code]"))return n;if("function"!=typeof n)throw new TypeError("Super expression must either be null or a function");if(void 0!==e){if(e.has(n))return e.get(n);e.set(n,t)}function t(){return F(n,arguments,L(this).constructor)}return t.prototype=Object.create(n.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),C(t,n)})(n)}function H(n){return n.name||n.__name__||n.displayName||"anonymous"}function J(n,e){try{delete n.name,n.name=e}catch(n){}return n.__name__=n.displayName=e,n}function U(){var n="0123456789abcdef";return"uid_"+"xxxxxxxxxx".replace(/./g,(function(){return n.charAt(Math.floor(Math.random()*n.length))}))+"_"+function(n){if("function"==typeof btoa)return btoa(encodeURIComponent(n).replace(/%([0-9A-F]{2})/g,(function(n,e){return String.fromCharCode(parseInt(e,16))}))).replace(/[=]/g,"");if("undefined"!=typeof Buffer)return Buffer.from(n,"utf8").toString("base64").replace(/[=]/g,"");throw new Error("Can not find window.btoa or Buffer")}((new Date).toISOString().slice(11,19).replace("T",".")).replace(/[^a-zA-Z0-9]/g,"").toLowerCase()}function K(n){try{return JSON.stringify([].slice.call(n),(function(n,e){return"function"==typeof e?"memoize["+function(n){if(R=R||new T,null==n||"object"!=typeof n&&"function"!=typeof n)throw new Error("Invalid object");var e=R.get(n);return e||(e=typeof n+":"+U(),R.set(n,e)),e}(e)+"]":function(n){var e=!1;try{(n instanceof window.Element||null!==n&&"object"==typeof n&&1===n.nodeType&&"object"==typeof n.style&&"object"==typeof n.ownerDocument)&&(e=!0)}catch(n){}return e}(e)?{}:e}))}catch(n){throw new Error("Arguments not serializable -- can not be used to memoize")}}function Y(){return{}}var Z=0,$=0;function G(n,e){void 0===e&&(e={});var t,r,o=e.thisNamespace,i=void 0!==o&&o,u=e.time,a=Z;Z+=1;var c=function(){for(var e=arguments.length,o=new Array(e),c=0;c<e;c++)o[c]=arguments[c];var s,f;a<$&&(t=null,r=null,a=Z,Z+=1),s=i?(r=r||new T).getOrSet(this,Y):t=t||{};try{f=K(o)}catch(e){return n.apply(this,arguments)}var d=s[f];if(d&&u&&Date.now()-d.time<u&&(delete s[f],d=null),d)return d.value;var l=Date.now(),h=n.apply(this,arguments);return s[f]={time:l,value:h},h};return c.reset=function(){t=null,r=null},J(c,(e.name||H(n))+"::memoized")}function Q(n){var e={};function t(){for(var t=arguments,r=this,o=arguments.length,i=new Array(o),u=0;u<o;u++)i[u]=arguments[u];var a=K(i);return e.hasOwnProperty(a)||(e[a]=z.try((function(){return n.apply(r,t)})).finally((function(){delete e[a]}))),e[a]}return t.reset=function(){e={}},J(t,H(n)+"::promiseMemoized")}function V(){}function X(n,e){if(void 0===e&&(e=1),e>=3)return"stringifyError stack overflow";try{if(!n)return"<unknown error: "+{}.toString.call(n)+">";if("string"==typeof n)return n;if(n instanceof Error){var t=n&&n.stack,r=n&&n.message;if(t&&r)return-1!==t.indexOf(r)?t:r+"\n"+t;if(t)return t;if(r)return r}return n&&n.toString&&"function"==typeof n.toString?n.toString():{}.toString.call(n)}catch(n){return"Error while stringifying error: "+X(n,e+1)}}function nn(n){return"string"==typeof n?n:n&&n.toString&&"function"==typeof n.toString?n.toString():{}.toString.call(n)}function en(n){return"[object RegExp]"==={}.toString.call(n)}function tn(n,e,t){if(n.hasOwnProperty(e))return n[e];var r=t();return n[e]=r,r}G.clear=function(){$=Z},G((function(n){if(Object.values)return Object.values(n);var e=[];for(var t in n)n.hasOwnProperty(t)&&e.push(n[t]);return e}));var rn,on=function(n){function e(e){var t;return(t=n.call(this,e)||this).name=t.constructor.name,"function"==typeof Error.captureStackTrace?Error.captureStackTrace(t,t.constructor):t.stack=new Error(e).stack,t}return M(e,n),e}(B(Error));function un(){var n=document.body;if(!n)throw new Error("Body element not found");return n}function an(){return Boolean(document.body)&&"complete"===document.readyState}function cn(){return Boolean(document.body)&&"interactive"===document.readyState}G((function(){return new z((function(n){if(an()||cn())return n();var e=setInterval((function(){if(an()||cn())return clearInterval(e),n()}),10)}))})),M((function(){return rn.apply(this,arguments)||this}),rn=on);var sn="undefined"!=typeof document?document.currentScript:null,fn=G((function(){if(sn)return sn;if(sn=function(){try{var n=function(){try{throw new Error("_")}catch(n){return n.stack||""}}(),e=/.*at [^(]*\((.*):(.+):(.+)\)$/gi.exec(n),t=e&&e[1];if(!t)return;for(var r=0,o=[].slice.call(document.getElementsByTagName("script")).reverse();r<o.length;r++){var i=o[r];if(i.src&&i.src===t)return i}}catch(n){}}())return sn;throw new Error("Can not determine current script")})),dn=U();function ln(n){void 0===n&&(n=window);var e="__post_robot_11_0_1__";return n!==window?n[e]:n[e]=n[e]||{}}G((function(){var n;try{n=fn()}catch(n){return dn}var e=n.getAttribute("data-uid");if(e&&"string"==typeof e)return e;if((e=n.getAttribute("data-uid-auto"))&&"string"==typeof e)return e;if(n.src){var t=function(n){for(var e="",t=0;t<n.length;t++){var r=n[t].charCodeAt(0)*t;n[t+1]&&(r+=n[t+1].charCodeAt(0)*(t-1)),e+=String.fromCharCode(97+Math.abs(r)%26)}return e}(JSON.stringify({src:n.src,dataset:n.dataset}));e="uid_"+t.slice(t.length-30)}else e=U();return n.setAttribute("data-uid-auto",e),e}));var hn=function(){return{}};function wn(n,e){return void 0===n&&(n="store"),void 0===e&&(e=hn),tn(ln(),n,(function(){var n=e();return{has:function(e){return n.hasOwnProperty(e)},get:function(e,t){return n.hasOwnProperty(e)?n[e]:t},set:function(e,t){return n[e]=t,t},del:function(e){delete n[e]},getOrSet:function(e,t){return tn(n,e,t)},reset:function(){n=e()},keys:function(){return Object.keys(n)}}}))}var pn,vn=function(){};function mn(){var n=ln();return n.WINDOW_WILDCARD=n.WINDOW_WILDCARD||new vn,n.WINDOW_WILDCARD}function yn(n,e){return void 0===n&&(n="store"),void 0===e&&(e=hn),wn("windowStore").getOrSet(n,(function(){var t=new T,r=function(n){return t.getOrSet(n,e)};return{has:function(e){return r(e).hasOwnProperty(n)},get:function(e,t){var o=r(e);return o.hasOwnProperty(n)?o[n]:t},set:function(e,t){return r(e)[n]=t,t},del:function(e){delete r(e)[n]},getOrSet:function(e,t){return tn(r(e),n,t)}}}))}function gn(){return wn("instance").getOrSet("instanceID",U)}function _n(n,e){var t=e.domain,r=yn("helloPromises"),o=r.get(n);o&&o.resolve({domain:t});var i=z.resolve({domain:t});return r.set(n,i),i}function bn(n,e){return(0,e.send)(n,"postrobot_hello",{instanceID:gn()},{domain:"*",timeout:-1}).then((function(e){var t=e.origin,r=e.data.instanceID;return _n(n,{domain:t}),{win:n,domain:t,instanceID:r}}))}function Wn(n,e){var t=e.send;return yn("windowInstanceIDPromises").getOrSet(n,(function(){return bn(n,{send:t}).then((function(n){return n.instanceID}))}))}function En(n){yn("knownWindows").set(n,!0)}function xn(n){return"object"==typeof n&&null!==n&&"string"==typeof n.__type__}function jn(n){return void 0===n?"undefined":null===n?"null":Array.isArray(n)?"array":"function"==typeof n?"function":"object"==typeof n?n instanceof Error?"error":"function"==typeof n.then?"promise":"[object RegExp]"==={}.toString.call(n)?"regex":"[object Date]"==={}.toString.call(n)?"date":"object":"string"==typeof n?"string":"number"==typeof n?"number":"boolean"==typeof n?"boolean":void 0}function Sn(n,e){return{__type__:n,__val__:e}}var kn,On=((pn={}).function=function(){},pn.error=function(n){return Sn("error",{message:n.message,stack:n.stack,code:n.code,data:n.data})},pn.promise=function(){},pn.regex=function(n){return Sn("regex",n.source)},pn.date=function(n){return Sn("date",n.toJSON())},pn.array=function(n){return n},pn.object=function(n){return n},pn.string=function(n){return n},pn.number=function(n){return n},pn.boolean=function(n){return n},pn.null=function(n){return n},pn[void 0]=function(n){return Sn("undefined",n)},pn),Pn={},An=((kn={}).function=function(){throw new Error("Function serialization is not implemented; nothing to deserialize")},kn.error=function(n){var e=n.stack,t=n.code,r=n.data,o=new Error(n.message);return o.code=t,r&&(o.data=r),o.stack=e+"\n\n"+o.stack,o},kn.promise=function(){throw new Error("Promise serialization is not implemented; nothing to deserialize")},kn.regex=function(n){return new RegExp(n)},kn.date=function(n){return new Date(n)},kn.array=function(n){return n},kn.object=function(n){return n},kn.string=function(n){return n},kn.number=function(n){return n},kn.boolean=function(n){return n},kn.null=function(n){return n},kn[void 0]=function(){},kn),Dn={};function In(){for(var n=wn("idToProxyWindow"),e=0,t=n.keys();e<t.length;e++){var r=t[e];n.get(r).shouldClean()&&n.del(r)}}function zn(n,e){var t=e.send,r=e.id,o=void 0===r?U():r,i=n.then((function(n){if(h(n))return w(n).name})),u=n.then((function(n){if(g(n))throw new Error("Window is closed, can not determine type");return s(n)?"popup":"iframe"}));i.catch(V),u.catch(V);var a=function(){return n.then((function(n){if(!g(n))return h(n)?w(n).name:i}))};return{id:o,getType:function(){return u},getInstanceID:Q((function(){return n.then((function(n){return Wn(n,{send:t})}))})),close:function(){return n.then(x)},getName:a,focus:function(){return n.then((function(n){n.focus()}))},isClosed:function(){return n.then((function(n){return g(n)}))},setLocation:function(e,t){return void 0===t&&(t={}),n.then((function(n){var r=window.location.protocol+"//"+window.location.host,o=t.method,i=void 0===o?"get":o,u=t.body;if(0===e.indexOf("/"))e=""+r+e;else if(!e.match(/^https?:\/\//)&&0!==e.indexOf(r))throw new Error("Expected url to be http or https url, or absolute path, got "+JSON.stringify(e));if("post"===i)return a().then((function(n){if(!n)throw new Error("Can not post to window without target name");!function(n){var e=n.url,t=n.target,r=n.body,o=n.method,i=void 0===o?"post":o,u=document.createElement("form");if(u.setAttribute("target",t),u.setAttribute("method",i),u.setAttribute("action",e),u.style.display="none",r)for(var a=0,c=Object.keys(r);a<c.length;a++){var s,f=c[a],d=document.createElement("input");d.setAttribute("name",f),d.setAttribute("value",null==(s=r[f])?void 0:s.toString()),u.appendChild(d)}un().appendChild(u),u.submit(),un().removeChild(u)}({url:e,target:n,method:i,body:u})}));if("get"!==i)throw new Error("Unsupported method: "+i);if(h(n))try{if(n.location&&"function"==typeof n.location.replace)return void n.location.replace(e)}catch(n){}n.location=e}))},setName:function(e){return n.then((function(n){var t=h(n),r=E(n);if(!t)throw new Error("Can not set name for cross-domain window: "+e);w(n).name=e,r&&r.setAttribute("name",e),i=z.resolve(e)}))}}}new z((function(n){if(window.document&&window.document.body)return n(window.document.body);var e=setInterval((function(){if(window.document&&window.document.body)return clearInterval(e),n(window.document.body)}),10)}));var Cn=function(){function n(n){var e=n.send,t=n.win,r=n.serializedWindow;this.id=void 0,this.isProxyWindow=!0,this.serializedWindow=void 0,this.actualWindow=void 0,this.actualWindowPromise=void 0,this.send=void 0,this.name=void 0,this.actualWindowPromise=new z,this.serializedWindow=r||zn(this.actualWindowPromise,{send:e}),wn("idToProxyWindow").set(this.getID(),this),t&&this.setWindow(t,{send:e})}var e=n.prototype;return e.getID=function(){return this.serializedWindow.id},e.getType=function(){return this.serializedWindow.getType()},e.isPopup=function(){return this.getType().then((function(n){return"popup"===n}))},e.setLocation=function(n,e){var t=this;return this.serializedWindow.setLocation(n,e).then((function(){return t}))},e.getName=function(){return this.serializedWindow.getName()},e.setName=function(n){var e=this;return this.serializedWindow.setName(n).then((function(){return e}))},e.close=function(){var n=this;return this.serializedWindow.close().then((function(){return n}))},e.focus=function(){var n=this,e=this.isPopup(),t=this.getName(),r=z.hash({isPopup:e,name:t}).then((function(e){var t=e.isPopup,r=e.name,o=n.getWindow();t&&r&&!o&&window.open("",r)})),o=this.serializedWindow.focus();return z.all([r,o]).then((function(){return n}))},e.isClosed=function(){return this.serializedWindow.isClosed()},e.getWindow=function(){return this.actualWindow},e.setWindow=function(n,e){var t=e.send;this.actualWindow=n,this.actualWindowPromise.resolve(this.actualWindow),this.serializedWindow=zn(this.actualWindowPromise,{send:t,id:this.getID()}),yn("winToProxyWindow").set(n,this)},e.awaitWindow=function(){return this.actualWindowPromise},e.matchWindow=function(n,e){var t=this,r=e.send;return z.try((function(){return t.actualWindow?n===t.actualWindow:z.hash({proxyInstanceID:t.getInstanceID(),knownWindowInstanceID:Wn(n,{send:r})}).then((function(e){var o=e.proxyInstanceID===e.knownWindowInstanceID;return o&&t.setWindow(n,{send:r}),o}))}))},e.unwrap=function(){return this.actualWindow||this},e.getInstanceID=function(){return this.serializedWindow.getInstanceID()},e.shouldClean=function(){return Boolean(this.actualWindow&&g(this.actualWindow))},e.serialize=function(){return this.serializedWindow},n.unwrap=function(e){return n.isProxyWindow(e)?e.unwrap():e},n.serialize=function(e,t){var r=t.send;return In(),n.toProxyWindow(e,{send:r}).serialize()},n.deserialize=function(e,t){var r=t.send;return In(),wn("idToProxyWindow").get(e.id)||new n({serializedWindow:e,send:r})},n.isProxyWindow=function(n){return Boolean(n&&!W(n)&&n.isProxyWindow)},n.toProxyWindow=function(e,t){var r=t.send;if(In(),n.isProxyWindow(e))return e;var o=e;return yn("winToProxyWindow").get(o)||new n({win:o,send:r})},n}();function Mn(n,e,t,r,o){var i=yn("methodStore"),u=wn("proxyWindowMethods");Cn.isProxyWindow(r)?u.set(n,{val:e,name:t,domain:o,source:r}):(u.del(n),i.getOrSet(r,(function(){return{}}))[n]={domain:o,name:t,val:e,source:r})}function Nn(n,e){var t=yn("methodStore"),r=wn("proxyWindowMethods");return t.getOrSet(n,(function(){return{}}))[e]||r.get(e)}function Rn(n,e,t,r,o){var i,u,a;u=(i={on:o.on,send:o.send}).on,a=i.send,wn("builtinListeners").getOrSet("functionCalls",(function(){return u("postrobot_method",{domain:"*"},(function(n){var e=n.source,t=n.origin,r=n.data,o=r.id,i=r.name,u=Nn(e,o);if(!u)throw new Error("Could not find method '"+i+"' with id: "+r.id+" in "+l(window));var c=u.source,s=u.domain,f=u.val;return z.try((function(){if(!b(s,t))throw new Error("Method '"+r.name+"' domain "+JSON.stringify(en(u.domain)?u.domain.source:u.domain)+" does not match origin "+t+" in "+l(window));if(Cn.isProxyWindow(c))return c.matchWindow(e,{send:a}).then((function(n){if(!n)throw new Error("Method call '"+r.name+"' failed - proxy window does not match source in "+l(window))}))})).then((function(){return f.apply({source:e,origin:t},r.args)}),(function(n){return z.try((function(){if(f.onError)return f.onError(n)})).then((function(){var e,t;throw n.stack&&(n.stack="Remote call to "+i+"("+(void 0===(e=r.args)&&(e=[]),(t=e,[].slice.call(t)).map((function(n){return"string"==typeof n?"'"+n+"'":void 0===n?"undefined":null===n?"null":"boolean"==typeof n?n.toString():Array.isArray(n)?"[ ... ]":"object"==typeof n?"{ ... }":"function"==typeof n?"() => { ... }":"<"+typeof n+">"})).join(", ")+") failed\n\n")+n.stack),n}))})).then((function(n){return{result:n,id:o,name:i}}))}))}));var c=t.__id__||U();n=Cn.unwrap(n);var s=t.__name__||t.name||r;return"string"==typeof s&&"function"==typeof s.indexOf&&0===s.indexOf("anonymous::")&&(s=s.replace("anonymous::",r+"::")),Cn.isProxyWindow(n)?(Mn(c,t,s,n,e),n.awaitWindow().then((function(n){Mn(c,t,s,n,e)}))):Mn(c,t,s,n,e),Sn("cross_domain_function",{id:c,name:s})}function Tn(n,e,t,r){var o,i=r.on,u=r.send;return function(n,e){void 0===e&&(e=Pn);var t=JSON.stringify(n,(function(n){var t=this[n];if(xn(this))return t;var r=jn(t);if(!r)return t;var o=e[r]||On[r];return o?o(t,n):t}));return void 0===t?"undefined":t}(t,((o={}).promise=function(t,r){return function(n,e,t,r,o){return Sn("cross_domain_zalgo_promise",{then:Rn(n,e,(function(n,e){return t.then(n,e)}),r,{on:o.on,send:o.send})})}(n,e,t,r,{on:i,send:u})},o.function=function(t,r){return Rn(n,e,t,r,{on:i,send:u})},o.object=function(n){return W(n)||Cn.isProxyWindow(n)?Sn("cross_domain_window",Cn.serialize(n,{send:u})):n},o))}function Ln(n,e,t,r){var o,i=r.send;return function(n,e){if(void 0===e&&(e=Dn),"undefined"!==n)return JSON.parse(n,(function(n,t){if(xn(this))return t;var r,o;if(xn(t)?(r=t.__type__,o=t.__val__):(r=jn(t),o=t),!r)return o;var i=e[r]||An[r];return i?i(o,n):o}))}(t,((o={}).cross_domain_zalgo_promise=function(n){return function(n,e,t){return new z(t.then)}(0,0,n)},o.cross_domain_function=function(t){return function(n,e,t,r){var o=t.id,i=t.name,u=r.send,a=function(t){function r(){var a=arguments;return Cn.toProxyWindow(n,{send:u}).awaitWindow().then((function(n){var c=Nn(n,o);if(c&&c.val!==r)return c.val.apply({source:window,origin:l()},a);var s=[].slice.call(a);return t.fireAndForget?u(n,"postrobot_method",{id:o,name:i,args:s},{domain:e,fireAndForget:!0}):u(n,"postrobot_method",{id:o,name:i,args:s},{domain:e,fireAndForget:!1}).then((function(n){return n.data.result}))})).catch((function(n){throw n}))}return void 0===t&&(t={}),r.__name__=i,r.__origin__=e,r.__source__=n,r.__id__=o,r.origin=e,r},c=a();return c.fireAndForget=a({fireAndForget:!0}),c}(n,e,t,{send:i})},o.cross_domain_window=function(n){return Cn.deserialize(n,{send:i})},o))}var qn={};function Fn(n,e,t,r){var o=r.on,i=r.send;return z.try((function(){var r=yn().getOrSet(n,(function(){return{}}));return r.buffer=r.buffer||[],r.buffer.push(t),r.flush=r.flush||z.flush().then((function(){if(g(n))throw new Error("Window is closed");var t,u=Tn(n,e,((t={}).__post_robot_11_0_1__=r.buffer||[],t),{on:o,send:i});delete r.buffer;for(var a=Object.keys(qn),c=[],s=0;s<a.length;s++){var f=a[s];try{qn[f](n,u,e)}catch(n){c.push(n)}}if(c.length===a.length)throw new Error("All post-robot messaging strategies failed:\n\n"+c.map((function(n,e){return e+". "+X(n)})).join("\n\n"))})),r.flush.then((function(){delete r.flush}))})).then(V)}function Bn(n){return wn("responseListeners").get(n)}function Hn(n){wn("responseListeners").del(n)}function Jn(n){return wn("erroredResponseListeners").has(n)}function Un(n){var e=n.name,t=n.win,r=n.domain,o=yn("requestListeners");if("*"===t&&(t=null),"*"===r&&(r=null),!e)throw new Error("Name required to get request listener");for(var i=0,u=[t,mn()];i<u.length;i++){var a=u[i];if(a){var c=o.get(a);if(c){var s=c[e];if(s){if(r&&"string"==typeof r){if(s[r])return s[r];if(s.__domain_regex__)for(var f=0,d=s.__domain_regex__;f<d.length;f++){var l=d[f],h=l.listener;if(b(l.regex,r))return h}}if(s["*"])return s["*"]}}}}}function Kn(n,e){var t=e.on,o=e.send,i=wn("receivedMessages");try{if(!window||window.closed||!n.source)return}catch(n){return}var u=n.source,a=n.origin,c=function(n,e,t,r){var o,i=r.on,u=r.send;try{o=Ln(e,t,n,{on:i,send:u})}catch(n){return}if(o&&"object"==typeof o&&null!==o){var a=o.__post_robot_11_0_1__;if(Array.isArray(a))return a}}(n.data,u,a,{on:t,send:o});if(c){En(u);for(var s,f=function(){var n=c[d];if(i.has(n.id))return{v:void 0};if(i.set(n.id,!0),g(u)&&!n.fireAndForget)return{v:void 0};0===n.origin.indexOf("file:")&&(a="file://");try{"postrobot_message_request"===n.type?function(n,e,t,r){var o=r.on,i=r.send,u=Un({name:t.name,win:n,domain:e}),a="postrobot_method"===t.name&&t.data&&"string"==typeof t.data.name?t.data.name+"()":t.name;function c(r,u,c){return z.flush().then((function(){if(!t.fireAndForget&&!g(n))try{return Fn(n,e,{id:U(),origin:l(window),type:"postrobot_message_response",hash:t.hash,name:t.name,ack:r,data:u,error:c},{on:o,send:i})}catch(n){throw new Error("Send response message failed for "+a+" in "+l()+"\n\n"+X(n))}}))}z.all([z.flush().then((function(){if(!t.fireAndForget&&!g(n))try{return Fn(n,e,{id:U(),origin:l(window),type:"postrobot_message_ack",hash:t.hash,name:t.name},{on:o,send:i})}catch(n){throw new Error("Send ack message failed for "+a+" in "+l()+"\n\n"+X(n))}})),z.try((function(){if(!u)throw new Error("No handler found for post message: "+t.name+" from "+e+" in "+window.location.protocol+"//"+window.location.host+window.location.pathname);return u.handler({source:n,origin:e,data:t.data})})).then((function(n){return c("success",n)}),(function(n){return c("error",null,n)}))]).then(V).catch((function(n){if(u&&u.handleError)return u.handleError(n);throw n}))}(u,a,n,{on:t,send:o}):"postrobot_message_response"===n.type?function(n,e,t){if(!Jn(t.hash)){var o,i=Bn(t.hash);if(!i)throw new Error("No handler found for post message response for message: "+t.name+" from "+e+" in "+window.location.protocol+"//"+window.location.host+window.location.pathname);if(!b(i.domain,e))throw new Error("Response origin "+e+" does not match domain "+(o=i.domain,Array.isArray(o)?"("+o.join(" | ")+")":r(o)?"RegExp("+o.toString()+")":o.toString()));if(n!==i.win)throw new Error("Response source does not match registered window");Hn(t.hash),"error"===t.ack?i.promise.reject(t.error):"success"===t.ack&&i.promise.resolve({source:n,origin:e,data:t.data})}}(u,a,n):"postrobot_message_ack"===n.type&&function(n,e,t){if(!Jn(t.hash)){var r=Bn(t.hash);if(!r)throw new Error("No handler found for post message ack for message: "+t.name+" from "+e+" in "+window.location.protocol+"//"+window.location.host+window.location.pathname);try{if(!b(r.domain,e))throw new Error("Ack origin "+e+" does not match domain "+r.domain.toString());if(n!==r.win)throw new Error("Ack source does not match registered window")}catch(n){r.promise.reject(n)}r.ack=!0}}(u,a,n)}catch(n){setTimeout((function(){throw n}),0)}},d=0;d<c.length;d++)if(s=f())return s.v}}function Yn(n,e,t){if(!n)throw new Error("Expected name");if("function"==typeof(e=e||{})&&(t=e,e={}),!t)throw new Error("Expected handler");var r=function n(e,t){var r=e.name,o=e.win,i=e.domain,u=yn("requestListeners");if(!r||"string"!=typeof r)throw new Error("Name required to add request listener");if(o&&"*"!==o&&Cn.isProxyWindow(o)){var a=o.awaitWindow().then((function(e){return n({name:r,win:e,domain:i},t)}));return{cancel:function(){a.then((function(n){return n.cancel()}),V)}}}var c=o;if(Array.isArray(c)){for(var s=[],f=0,d=c;f<d.length;f++)s.push(n({name:r,domain:i,win:d[f]},t));return{cancel:function(){for(var n=0;n<s.length;n++)s[n].cancel()}}}if(Array.isArray(i)){for(var l=[],h=0,w=i;h<w.length;h++)l.push(n({name:r,win:c,domain:w[h]},t));return{cancel:function(){for(var n=0;n<l.length;n++)l[n].cancel()}}}var p=Un({name:r,win:c,domain:i});c&&"*"!==c||(c=mn());var v=(i=i||"*").toString();if(p)throw c&&i?new Error("Request listener already exists for "+r+" on domain "+i.toString()+" for "+(c===mn()?"wildcard":"specified")+" window"):c?new Error("Request listener already exists for "+r+" for "+(c===mn()?"wildcard":"specified")+" window"):i?new Error("Request listener already exists for "+r+" on domain "+i.toString()):new Error("Request listener already exists for "+r);var m,y,g=u.getOrSet(c,(function(){return{}})),_=tn(g,r,(function(){return{}}));return en(i)?(m=tn(_,"__domain_regex__",(function(){return[]}))).push(y={regex:i,listener:t}):_[v]=t,{cancel:function(){delete _[v],y&&(m.splice(m.indexOf(y,1)),m.length||delete _.__domain_regex__),Object.keys(_).length||delete g[r],c&&!Object.keys(g).length&&u.del(c)}}}({name:n,win:e.window,domain:e.domain||"*"},{handler:t||e.handler,handleError:e.errorHandler||function(n){throw n}});return{cancel:function(){r.cancel()}}}function Zn(n,e,t){"function"==typeof(e=e||{})&&(t=e,e={});var r,o=new z;return e.errorHandler=function(n){r.cancel(),o.reject(n)},r=Yn(n,e,(function(n){if(r.cancel(),o.resolve(n),t)return t(n)})),o.cancel=r.cancel,o}qn.postrobot_post_message=function(n,e,t){0===t.indexOf("file:")&&(t="*"),n.postMessage(e,t)};var $n=function(n,e,t,r){var o=(r=r||{}).domain||"*",i=r.timeout||-1,u=r.timeout||5e3,a=r.fireAndForget||!1;return Cn.toProxyWindow(n,{send:$n}).awaitWindow().then((function(n){return z.try((function(){if(function(n,e,t){if(!n)throw new Error("Expected name");if(t&&"string"!=typeof t&&!Array.isArray(t)&&!en(t))throw new TypeError("Can not send "+n+". Expected domain "+JSON.stringify(t)+" to be a string, array, or regex");if(g(e))throw new Error("Can not send "+n+". Target window is closed")}(e,n,o),function(n,e){var t=_(e);if(t)return t===n;if(e===n)return!1;if(function(n){void 0===n&&(n=window);try{if(n.top)return n.top}catch(n){}if(c(n)===n)return n;try{if(p(window,n)&&window.top)return window.top}catch(n){}try{if(p(n,window)&&window.top)return window.top}catch(n){}for(var e=0,t=function n(e){for(var t=[],r=0,o=v(e);r<o.length;r++){var i=o[r];t.push(i);for(var u=0,a=n(i);u<a.length;u++)t.push(a[u])}return t}(n);e<t.length;e++){var r=t[e];try{if(r.top)return r.top}catch(n){}if(c(r)===r)return r}}(e)===e)return!1;for(var r=0,o=v(n);r<o.length;r++)if(o[r]===e)return!0;return!1}(window,n))return function(n,e,t){void 0===e&&(e=5e3),void 0===t&&(t="Window");var r=function(n){return yn("helloPromises").getOrSet(n,(function(){return new z}))}(n);return-1!==e&&(r=r.timeout(e,new Error(t+" did not load after "+e+"ms"))),r}(n,u)})).then((function(e){return function(n,e,t,r){var o=r.send;return z.try((function(){return"string"==typeof e?e:z.try((function(){return t||bn(n,{send:o}).then((function(n){return n.domain}))})).then((function(n){if(!b(e,e))throw new Error("Domain "+nn(e)+" does not match "+nn(e));return n}))}))}(n,o,(void 0===e?{}:e).domain,{send:$n})})).then((function(r){var o,u,c=r,s="postrobot_method"===e&&t&&"string"==typeof t.name?t.name+"()":e,f=new z,d=e+"_"+U();if(!a){var h={name:e,win:n,domain:c,promise:f};!function(n,e){wn("responseListeners").set(n,e)}(d,h);var w=yn("requestPromises").getOrSet(n,(function(){return[]}));w.push(f),f.catch((function(){!function(n){wn("erroredResponseListeners").set(n,!0)}(d),Hn(d)}));var p=function(n){return yn("knownWindows").get(n,!1)}(n)?1e4:2e3,v=i,m=p,y=v,_=(o=function(){return g(n)?f.reject(new Error("Window closed for "+e+" before "+(h.ack?"response":"ack"))):h.cancelled?f.reject(new Error("Response listener was cancelled for "+e)):(m=Math.max(m-500,0),-1!==y&&(y=Math.max(y-500,0)),h.ack||0!==m?0===y?f.reject(new Error("No response for postMessage "+s+" in "+l()+" in "+v+"ms")):void 0:f.reject(new Error("No ack for postMessage "+s+" in "+l()+" in "+p+"ms")))},500,function n(){u=setTimeout((function(){o(),n()}),500)}(),{cancel:function(){clearTimeout(u)}});f.finally((function(){_.cancel(),w.splice(w.indexOf(f,1))})).catch(V)}return Fn(n,c,{id:U(),origin:l(window),type:"postrobot_message_request",hash:d,name:e,data:t,fireAndForget:a},{on:Yn,send:$n}).then((function(){return a?f.resolve():f}),(function(n){throw new Error("Send request message failed for "+s+" in "+l()+"\n\n"+X(n))}))}))}))};function Gn(n,e,t){return Tn(n,e,t,{on:Yn,send:$n})}function Qn(n,e,t){return Ln(n,e,t,{on:Yn,send:$n})}function Vn(n){return new Cn({send:$n,win:n})}function Xn(n){return Cn.toProxyWindow(n,{send:$n})}function ne(){var n,e,t,r;ln().initialized||(ln().initialized=!0,e=(n={on:Yn,send:$n}).on,t=n.send,(r=ln()).receiveMessage=r.receiveMessage||function(n){return Kn(n,{on:e,send:t})},function(n){var e=n.on,t=n.send;wn().getOrSet("postMessageListener",(function(){return(n=window).addEventListener("message",r=function(n){!function(n,e){var t=e.on,r=e.send;z.try((function(){var e=n.source||n.sourceElement,o=n.origin||n.originalEvent&&n.originalEvent.origin,i=n.data;if("null"===o&&(o="file://"),e){if(!o)throw new Error("Post message did not have origin domain");Kn({source:e,origin:o,data:i},{on:t,send:r})}}))}(n,{on:e,send:t})}),{cancel:function(){n.removeEventListener("message",r)}};var n,r}))}({on:Yn,send:$n}),function(n){var e=n.on,t=n.send;wn("builtinListeners").getOrSet("helloListener",(function(){var n=e("postrobot_hello",{domain:"*"},(function(n){return _n(n.source,{domain:n.origin}),{instanceID:gn()}})),r=_();return r&&bn(r,{send:t}).catch((function(n){})),n}))}({on:Yn,send:$n}))}function ee(){var n;!function(){for(var n=wn("responseListeners"),e=0,t=n.keys();e<t.length;e++){var r=t[e],o=n.get(r);o&&(o.cancelled=!0),n.del(r)}}(),(n=wn().get("postMessageListener"))&&n.cancel(),delete window.__post_robot_11_0_1__}var te=!0;function re(n){for(var e=0,t=yn("requestPromises").get(n,[]);e<t.length;e++)t[e].reject(new Error("Window "+(g(n)?"closed":"cleaned up")+" before response")).catch(V)}ne()}])}));

// Included by build-post-robot-probe.mjs inside the bundled userscript closure.
function installKeeWebXPostRobotProbe(robot) {
    'use strict';
    const APP_ORIGIN = 'https://keewebx.app';
    const app = location.origin === APP_ORIGIN && /^\/app\/?$/.test(location.pathname);
    if (window.top !== window || (location.origin === APP_ORIGIN && !app)) return;

    const HELLO = 'kwx-postrobot-probe-hello-v1';
    const PING = 'kwx-postrobot-probe-ping-v1';
    const TIMEOUT = 5000;
    const boot = crypto.randomUUID();
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
    const errorText = error => error instanceof Error ? error.message : String(error);
    let child;
    let session;
    let lastAppBoot;
    let testing = false;
    let disposed = false;
    const listeners = [];

    const host = document.createElement('div');
    host.id = 'keewebx-postrobot-probe';
    host.style.cssText = 'position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom, 0px));z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial;font:14px system-ui;color:#172033}button,input{box-sizing:border-box;font:inherit;min-height:42px;border:1px solid #aebbd0;border-radius:9px;padding:8px 10px;background:#f3f7ff;color:#172033}button{cursor:pointer}button:disabled{opacity:.6}section{box-sizing:border-box;width:min(340px,calc(100vw - 20px));padding:12px;background:#fff;border:1px solid #aebbd0;border-radius:12px;box-shadow:0 4px 20px #0003;margin-bottom:8px}section[hidden]{display:none}h2{font-size:15px;margin:0 0 8px}p,label,pre{font-size:13px;line-height:1.4;overflow-wrap:anywhere}label{display:block}input{display:block;width:100%;background:#fff;margin:4px 0 10px}footer{display:flex;flex-wrap:wrap;gap:8px}pre{white-space:pre-wrap;max-height:130px;overflow:auto;background:#f5f7fa;padding:8px;border-radius:6px}';
    shadow.append(style);
    const panel = document.createElement('section');
    panel.hidden = true;
    const title = document.createElement('h2');
    title.textContent = 'Post-robot connection test';
    const help = document.createElement('p');
    help.textContent = app
        ? 'Open a linked website from this original tab. The test sends random messages only and does not read databases or passwords.'
        : 'Run the test to message the original KeeWebX window directly, without requesting a tab switch.';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = app ? 'Waiting for a linked website.' : 'Open this website from the KeeWebX test panel.';
    const label = document.createElement('label');
    label.textContent = 'Test website (HTTPS)';
    const target = document.createElement('input');
    target.type = 'url';
    target.value = 'https://example.com/';
    target.autocomplete = 'off';
    target.spellcheck = false;
    label.append(target);
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = app ? 'Open linked website' : 'Test background reply';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = 'Disconnect';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    const footer = document.createElement('footer');
    footer.append(action);
    if (app) footer.append(revoke);
    footer.append(close);
    const history = document.createElement('pre');
    history.setAttribute('aria-label', 'Test history');
    history.textContent = 'post-robot 11.0.1 · No GM storage polling';
    panel.append(title, help);
    if (app) panel.append(label);
    panel.append(status, footer, history);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'Post-robot test';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
    };
    close.onclick = () => {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
    };
    shadow.append(panel, toggle);
    document.body.append(host);

    function record(text) {
        history.textContent = `${new Date().toLocaleTimeString()} ${text}\n${history.textContent}`.split('\n').slice(0, 8).join('\n');
    }

    function validate(event) {
        if (disposed || !child || event.source !== child || !/^https:\/\/[^/]+$/.test(event.origin)) {
            throw new Error('The source window is not linked. Link the website again from KeeWebX.');
        }
        const data = event.data;
        if (!object(data) || !id(data.clientBoot) || !id(data.nonce) ||
            !Number.isFinite(data.sentAt) || !Number.isFinite(data.deadline) ||
            data.sentAt > Date.now() + 1000 || data.deadline <= Date.now() ||
            data.deadline - data.sentAt !== TIMEOUT) {
            throw new Error('The request expired or has an invalid format.');
        }
        return data;
    }

    function snapshot(event, data) {
        return {
            appBoot: boot, clientBoot: data.clientBoot, nonce: data.nonce,
            sentAt: data.sentAt, deadline: data.deadline, repliedAt: Date.now(),
            requestOrigin: event.origin, visibility: document.visibilityState,
            focused: document.hasFocus()
        };
    }

    if (app) {
        // The window reference is the boundary for this harmless diagnostic.
        // This is NOT authorization for vault or credential access.
        listeners.push(robot.on(HELLO, { domain: /^https:\/\/[^/]+$/ }, event => {
            const data = validate(event);
            session = { clientBoot: data.clientBoot, origin: event.origin, token: crypto.randomUUID() };
            status.textContent = `Linked ${event.origin}; page marker ${boot.slice(0, 8)}.`;
            return { ...snapshot(event, data), token: session.token };
        }));
        listeners.push(robot.on(PING, { domain: /^https:\/\/[^/]+$/ }, event => {
            const data = validate(event);
            if (!session || data.clientBoot !== session.clientBoot || event.origin !== session.origin ||
                data.token !== session.token || data.appBoot !== boot) {
                throw new Error('The link is no longer valid. Connect again.');
            }
            const reply = snapshot(event, data);
            record(`Reply sent; page ${reply.visibility}; source ${event.origin}`);
            return reply;
        }));
        action.onclick = () => {
            try {
                const url = new URL(target.value);
                if (url.protocol !== 'https:' || url.username || url.password || url.origin === APP_ORIGIN) {
                    throw new Error('Choose a different HTTPS website, such as https://example.com/');
                }
                // Keep this synchronous inside the user's tap for Safari popup rules.
                const opened = window.open(url.href, `kwx-postrobot-${crypto.randomUUID()}`);
                if (!opened) throw new Error('Safari blocked the new tab. Allow pop-ups and try again.');
                child = opened;
                session = undefined;
                status.textContent = 'Linked website opened. Click "Post-robot test" on the website.';
                record(`Linked website: ${url.origin}`);
            } catch (error) { status.textContent = errorText(error); }
        };
        revoke.onclick = () => {
            child = undefined;
            session = undefined;
            status.textContent = 'Disconnected. The website tab remains open.';
            record('Link removed');
        };
    } else {
        revoke.remove();
        const original = window.opener;

        function verify(reply, request, origin, expectedAppBoot) {
            if (disposed || location.origin !== origin || Date.now() >= request.deadline ||
                !object(reply) || reply.clientBoot !== boot || reply.nonce !== request.nonce ||
                reply.sentAt !== request.sentAt || reply.deadline !== request.deadline ||
                !id(reply.appBoot) || (expectedAppBoot && reply.appBoot !== expectedAppBoot) ||
                reply.requestOrigin !== origin || !Number.isFinite(reply.repliedAt) ||
                reply.repliedAt < request.sentAt || reply.repliedAt >= request.deadline ||
                !['visible', 'hidden'].includes(reply.visibility) || typeof reply.focused !== 'boolean') {
                throw new Error('Received an expired reply, a mismatched source, or a reply for a changed page.');
            }
            return reply;
        }

        function request() {
            const sentAt = Date.now();
            return { clientBoot: boot, nonce: crypto.randomUUID(), sentAt, deadline: sentAt + TIMEOUT };
        }

        action.onclick = async () => {
            if (testing) return;
            testing = true;
            action.disabled = true;
            let phase = 'Handshake';
            let phaseStarted = performance.now();
            try {
                if (!original || original.closed) {
                    throw new Error('No usable source window. Open the website with "Open linked website" in KeeWebX; independent tabs cannot connect directly.');
                }
                const origin = location.origin;
                status.textContent = 'Handshaking with the original KeeWebX tab...';
                const helloRequest = request();
                const helloEvent = await robot.send(original, HELLO, helloRequest, { domain: APP_ORIGIN, timeout: TIMEOUT });
                const hello = verify(helloEvent.data, helloRequest, origin);
                if (!id(hello.token)) throw new Error('The handshake response is missing a link token.');
                if (lastAppBoot && lastAppBoot !== hello.appBoot) throw new Error('The original KeeWebX page reloaded. Its previous page state cannot be reused.');
                phase = 'Reply';
                phaseStarted = performance.now();
                status.textContent = 'Testing a background reply...';
                const pingRequest = { ...request(), appBoot: hello.appBoot, token: hello.token };
                const started = performance.now();
                const event = await robot.send(original, PING, pingRequest, { domain: APP_ORIGIN, timeout: TIMEOUT });
                const reply = verify(event.data, pingRequest, origin, hello.appBoot);
                const elapsed = Math.round(performance.now() - started);
                lastAppBoot = reply.appBoot;
                status.textContent = `Success: ${elapsed} ms; KeeWebX replied while ${reply.visibility}${reply.focused ? ', focused' : ', unfocused'}; page marker ${reply.appBoot.slice(0, 8)}.`;
                record(`Success ${elapsed} ms · ${reply.visibility} · page ${reply.appBoot.slice(0, 8)}`);
            } catch (error) {
                const detail = errorText(error);
                const timeout = /timeout|timed out|no ack|no response/i.test(detail);
                status.textContent = timeout
                    ? `${phase} timed out: waited about ${Math.round(performance.now() - phaseStarted)} ms (limit ${TIMEOUT} ms); no tab switch was requested.`
                    : `Test failed: ${detail}`;
                record(status.textContent);
            } finally {
                testing = false;
                action.disabled = false;
            }
        };
    }

    // A real page reload intentionally loses the app-side association. A BFCache
    // restore invalidates the old test and requires a fresh association too.
    addEventListener('pagehide', () => {
        disposed = true;
        child = undefined;
        session = undefined;
        for (const listener of listeners) listener.cancel();
    });
    addEventListener('pageshow', event => {
        if (event.persisted) {
            status.textContent = 'Page restored from cache. Reload the test page and link the website again.';
            action.disabled = true;
        }
    });
}

installKeeWebXPostRobotProbe(module.exports);
})();
