angular.module('greenWalletSendControllers',
    ['greenWalletServices'])
.controller('SendController', ['$scope', 'wallets', 'tx_sender', 'cordovaReady', 'notices', 'branches', 'facebook', 'wallets', '$routeParams', 'hostname', 'gaEvent', 'reddit', '$modal', '$location', '$rootScope', '$q', 'parse_bitcoin_uri', 'qrcode', 'sound',
         function SendController($scope, wallets, tx_sender, cordovaReady, notices, branches, facebook, wallets, $routeParams, hostname, gaEvent, reddit, $modal, $location, $rootScope, $q, parse_bitcoin_uri, qrcode, sound) {
    if (!wallets.requireWallet($scope)) return;    

    var _verify_tx = function(that, rawtx, destination, satoshis, change_pointer, no_electrum) {
        var d = $q.defer();
        var tx = Bitcoin.Transaction.deserialize(rawtx);

        if (destination && (0 != destination.indexOf('GA'))) {  // we can't verify GA* addresses
            // decode the expected destination address
            var bytes = Bitcoin.base58.decode(destination);
            var hash = bytes.slice(0, 21);
            var hash_words = Bitcoin.convert.bytesToWordArray(hash);

            var checksum = Bitcoin.CryptoJS.SHA256(Bitcoin.CryptoJS.SHA256(hash_words));
            checksum = Bitcoin.convert.wordArrayToBytes(checksum);

            if (checksum[0] != bytes[21] ||
                checksum[1] != bytes[22] ||
                checksum[2] != bytes[23] ||
                checksum[3] != bytes[24]) {
                    return $q.reject(gettext("Checksum validation failed!"));
            }

            var version = hash[0];
            hash = hash.slice(1);
            var cur_version = Bitcoin.network[cur_net].addressVersion;
            var cur_p2sh_version = Bitcoin.network[cur_net].p2shVersion;
            if (version != cur_version && version != cur_p2sh_version) {
                return $q.reject(gettext("Version "+version+" not supported!"));
            }

            // verify the first output
            var chunks = tx.outs[0].script.chunks;
            if (version == cur_version) {
                if (chunks.length != 5) return $q.reject(gettext('Invalid pubkey hash script length'));
                if (chunks[0] != Bitcoin.Opcode.map.OP_DUP) return $q.reject(gettext('OP_DUP missing'));
                if (chunks[1] != Bitcoin.Opcode.map.OP_HASH160) return $q.reject(gettext('OP_HASH160 missing'));
                if (Bitcoin.convert.bytesToHex(chunks[2]) != Bitcoin.convert.bytesToHex(hash)) return $q.reject(gettext('Invalid pubkey hash'));
                if (chunks[3] != Bitcoin.Opcode.map.OP_EQUALVERIFY) return $q.reject(gettext('OP_EQUALVERIFY missing'));
                if (chunks[4] != Bitcoin.Opcode.map.OP_CHECKSIG) return $q.reject(gettext('OP_CHECKSIG missing'));
            } else if (version == cur_p2sh_version) {
                if (chunks.length != 3) return $q.reject(gettext('Invalid out P2SH script length'));
                if (chunks[0] != Bitcoin.Opcode.map.OP_HASH160) return $q.reject(gettext('out OP_HASH160 missing'));
                if (Bitcoin.convert.bytesToHex(chunks[1]) != Bitcoin.convert.bytesToHex(hash)) return $q.reject(gettext('Invalid out P2SH hash'));
                if (chunks[2] != Bitcoin.Opcode.map.OP_EQUAL) return $q.reject(gettext('out OP_EQUAL missing'));
            }
        }

        // calculate the inputs value
        var in_value_promises = [];
        var in_value = Bitcoin.BigInteger.valueOf(0);
        for (var i = 0; i < tx.ins.length; i++) {
            var outpoint = tx.ins[i].outpoint;
            in_value_promises.push($scope.wallet.get_tx_output_value(outpoint.hash, outpoint.index, no_electrum));
        }
        return $q.all(in_value_promises).then(function(values) {
            for (var i = 0; i < values.length; ++i) {
                if (!values[i]) return $q.reject(gettext('Missing input'));
                in_value = in_value.add(values[i]);  // already BigInteger
            }
            if (in_value.compareTo(Bitcoin.BigInteger.valueOf(0)) <= 0)
                // just in case we have some bug in summing, like missing valueOf
                return $q.reject(gettext('Inputs value is not larger than zero'));

            // calculate the outputs value
            if (tx.outs.length < 1 || tx.outs.length > 2) {
                return $q.reject(tx.outs.length + gettext(' is not a valid number of outputs'));
            }
            var out_value = new Bitcoin.BigInteger(tx.outs[0].value.toString());
            if (tx.outs[1]) {
                out_value = out_value.add(new Bitcoin.BigInteger(tx.outs[1].value.toString()));
            }

            // calculate fees
            var fee = in_value.subtract(out_value), recipient_fee = Bitcoin.BigInteger.valueOf(0);
            // subtract mod 10000 to allow anti-dust (<5430) fee
            if (that.add_fee == 'recipient') recipient_fee = fee.subtract(fee.mod(Bitcoin.BigInteger.valueOf(10000)));

            // check output value
            if (new Bitcoin.BigInteger(tx.outs[0].value.toString()).compareTo(
                    new Bitcoin.BigInteger(satoshis).subtract(recipient_fee)) != 0) {
                return $q.reject(gettext('Invalid output value'));
            }

            // check fee
            var kB = Math.ceil(rawtx.length / 1000) * 2;
            var expectedMaxFee = Bitcoin.BigInteger.valueOf(10000).multiply(Bitcoin.BigInteger.valueOf(kB));
            if (fee.compareTo(expectedMaxFee) > 0) {
                return $q.reject(gettext('Fee is too large (%1, expected at most %2)').replace('%1', fee.toString()).replace('%2', expectedMaxFee.toString()));
            }
            var expectedMinFee = Bitcoin.BigInteger.valueOf(10000);
            if (fee.compareTo(expectedMinFee) < 0) {
                return $q.reject(gettext('Fee is too small (%1, expected at lest %2)').replace('%1', fee.toString()).replace('%2', expectedMinFee.toString()));
            }

            // check change output if present
            if (tx.outs.length == 2) {
                var change_branch = $q.when($scope.wallet.hdwallet.derive(branches.REGULAR));
                var change_key = change_branch.then(function(change_branch) {
                    return change_branch.derive(change_pointer);
                });
                var change_key_bytes = change_key.then(function(change_key) {
                    return change_key.pub.toBytes(true);
                });

                var gawallet = new Bitcoin.HDWallet();
                gawallet.network = cur_net;
                gawallet.pub = new Bitcoin.ECPubKey(Bitcoin.convert.hexToBytes(deposit_pubkey));
                gawallet.chaincode = Bitcoin.convert.hexToBytes(deposit_chaincode);
                gawallet.depth = 0;
                gawallet.index = 0;
                return change_key_bytes.then(function(change_key_bytes) {
                    return $q.when(gawallet.derive(1)).then(function(gawallet) {
                        return $q.when(gawallet.subpath($scope.wallet.gait_path)).then(function(gawallet) {
                            return $q.when(gawallet.derive(change_pointer)).then(function(change_gait_key) {
                                var script_to_hash = new Bitcoin.Script();
                                script_to_hash.writeOp(Bitcoin.Opcode.map.OP_2);
                                if ($scope.wallet.old_server) {
                                    script_to_hash.writeBytes(Bitcoin.convert.hexToBytes(deposit_pubkey));
                                } else {
                                    script_to_hash.writeBytes(change_gait_key.pub.toBytes(true));
                                }
                                script_to_hash.writeBytes(change_key_bytes);
                                script_to_hash.writeOp(Bitcoin.Opcode.map.OP_2);
                                script_to_hash.writeOp(Bitcoin.Opcode.map.OP_CHECKMULTISIG);

                                var hash160 = Bitcoin.Util.sha256ripe160(Bitcoin.convert.bytesToWordArray(script_to_hash.buffer)).toString();
                                var chunks = tx.outs[1].script.chunks;
                                if (chunks.length != 3) return $q.reject(gettext('Invalid change P2SH script length'));
                                if (chunks[0] != Bitcoin.Opcode.map.OP_HASH160) return $q.reject(gettext('change OP_HASH160 missing'));
                                if (Bitcoin.convert.bytesToHex(chunks[1]) != hash160) return $q.reject(gettext('Invalid change P2SH hash'));
                                if (chunks[2] != Bitcoin.Opcode.map.OP_EQUAL) return $q.reject(gettext('change OP_EQUAL missing'));

                                return {success: true};
                            });
                        });
                    });
                });
            }

            return {success: true};
        });
    };
    var verify_tx = function(that, rawtx, destination, satoshis, change_pointer) {
        var verify = function(no_electrum) {
            return _verify_tx(that, rawtx, destination, satoshis, change_pointer, no_electrum);
        };
        if (tx_sender.electrum) {
            var d = $q.defer();
            tx_sender.electrum.checkConnectionsAvailable().then(function() {
                d.resolve(verify(false));
            }, function() {
                $modal.open({
                    templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_no_electrum.html',
                    windowClass: 'twofactor' // display on top of loading indicator
                }).result.then(function()  {
                    d.resolve(verify(true));
                }, function() {
                    d.reject(gettext('No Electrum servers reachable'));
                });
            });
            return d.promise;
        } else {
            return verify(true);
        }
    }
    var iframe;
    var mul = {'BTC': 1, 'mBTC': 1000, 'µBTC': 1000000}[$scope.wallet.unit];
    var parseContact = function(str) {
        var json = Bitcoin.CryptoJS.enc.Utf8.stringify(Bitcoin.convert.bytesToWordArray(
                        Bitcoin.base58.decode(str)));
        return JSON.parse(json);
    };
    $scope.send_tx = {
        add_fee: 'sender',  // used to be changeable from wallet_send.html, removed for now
        instant: $routeParams.contact ? (parseContact($routeParams.contact).requires_instant || false) : false,
        recipient: $routeParams.contact ? parseContact($routeParams.contact) : null,
        read_qr_code: function($event)  {
            gaEvent('Wallet', 'SendReadQrCode');
            var that = this;
            qrcode.scan($scope, $event, '_send').then(function(text) {
                gaEvent('Wallet', 'SendReadQrCodeSuccessful');
                $rootScope.safeApply(function() {
                    parsed_uri = parse_bitcoin_uri(text);
                    if (parsed_uri.recipient) {
                        that.recipient = parsed_uri.recipient;
                        if (parsed_uri.amount) {
                            that.amount = btcToUnit(parsed_uri.amount);
                        }
                    } else {
                        that.recipient = text;
                    }
                });
            }, function(error) {
                gaEvent('Wallet', 'SendReadQrCodeFailed', error);
                notices.makeNotice('error', error);
            });
        },
        stop_scanning_qr_code: function() {
            qrcode.stop_scanning($scope);
        },
        do_send_fb: function(that, enckey, satoshis, key, pointer) {
            $scope.send_fb_via_fb = function() {
                $scope.send_fb_via_fb_clicked = true;
                $rootScope.is_loading += 1;
                facebook.login({}).then(function() {
                    $rootScope.is_loading -= 1;
                    FB.ui({
                        method: 'send',
                        link: 'https://' + hostname + '/redeem/' + enckey + '/?amount=' + satoshis,
                        to: that.recipient.address
                    });
                }, function() {
                    $rootScope.is_loading -= 1;
                    notices.makeNotice('error', gettext('Facebook login failed'));
                });
                
            }
            $scope.send_fb_via_fb_clicked = false;
            $rootScope.is_loading -= 1;
            $modal.open({
                templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_fb_message.html',
                scope: $scope
            }).result.then(function() {
                $location.url('/transactions/');
            }, function() {
                // cancel - reverse the tx
                $rootScope.is_loading += 1;
                tx_sender.call("http://greenaddressit.com/vault/prepare_sweep_social",
                        key.pub.toBytes(), false).then(function(data) {
                    data.prev_outputs = [];
                    for (var i = 0; i < data.prevout_scripts.length; i++) {
                        data.prev_outputs.push(
                            {branch: branches.EXTERNAL, pointer: pointer,
                             script: data.prevout_scripts[i]})
                    }
                    wallets.sign_and_send_tx(undefined, data, true, null, gettext('Transaction reversed!')).finally(function() {
                        $rootScope.is_loading -= 1;
                        $location.url('/transactions/');
                    });  // priv_der=true
                }, function(error) {
                    $rootScope.is_loading -= 1;
                    gaEvent('Wallet', 'TransactionsTabRedeemFailed', error.desc);
                    notices.makeNotice('error', error.desc);
                });
            });            
        },
        do_send_email: function(that, enckey, satoshis) {
            tx_sender.call("http://greenaddressit.com/vault/send_email", that.recipient.address,
                    'https://' + hostname + '/redeem/' + enckey + '/?amount=' + satoshis).then(
                function() {
                    $rootScope.is_loading -= 1;
                    notices.makeNotice('success', gettext('Email sent'));
                    $location.url('/transactions/');
                }, function(err) {
                    $rootScope.is_loading -= 1;
                    notices.makeNotice('error', gettext('Failed sending email') + ': ' + err.desc);
                }
            );
        },
        do_send_reddit: function(that, enckey, satoshis) {
            if ($scope.wallet.send_from) $scope.wallet.send_from = null;
            tx_sender.call("http://greenaddressit.com/vault/send_reddit", that.recipient.address,
                    'https://' + hostname + '/redeem/' + enckey + '/?amount=' + satoshis).then(
                function(json) {
                    $rootScope.is_loading -= 1;
                    notices.makeNotice('success', gettext('Reddit message sent'));
                    sound.play(BASE_URL + "/static/sound/coinsent.mp3", $scope);
                    $location.url('/transactions/');
                }, function(err) {
                    $rootScope.is_loading -= 1;
                    notices.makeNotice('error', gettext('Failed sending Reddit message') + ': ' + err.desc);
                }
            );
        },
        _send_social_ga: function(satoshis) {
            var that = this, to_addr = {type: this.recipient.type,
                                        id: this.recipient.address};
            var priv_data = {social_destination: that.recipient.name, instant: that.instant};
            if ($scope.wallet.send_from) priv_data.reddit_from = $scope.wallet.send_from;
            tx_sender.call("http://greenaddressit.com/vault/prepare_tx", satoshis, to_addr, this.add_fee,
                           priv_data).then(function(data) {
                wallets.sign_and_send_tx($scope, data).then(function() {
                    if ($scope.wallet.send_from) $scope.wallet.send_from = null;
                    $location.url('/transactions/');
                }).finally(function() { that.sending = false; });
            }, function(error) {
                that.sending = false;
                notices.makeNotice('error', error.desc);
            });
        },
        amount_to_satoshis: function(amount) {
            var div = {'BTC': 1, 'mBTC': 1000, 'µBTC': 1000000}[$scope.wallet.unit];
            return Bitcoin.Util.parseValue(amount).divide(Bitcoin.BigInteger.valueOf(div)).toString();
        },
        _send_social: function(do_send) {
            var that = this;
            var satoshis = that.amount_to_satoshis(this.amount);
            if (this.recipient.has_wallet) {
                this._send_social_ga(satoshis);
                return;
            }
            $rootScope.is_loading += 1;
            var send = function(key, pointer) {
                var to_addr = key.getAddress().toString();
                var add_fee = that.add_fee;
                var priv_data = {pointer: pointer,
                                 pubkey: key.pub.toBytes(),
                                 social_destination: that.recipient.name,
                                 external_private: true,
                                 instant: that.instant};
                if ($scope.wallet.send_from) priv_data.reddit_from = $scope.wallet.send_from;
                tx_sender.call("http://greenaddressit.com/vault/prepare_tx", satoshis, to_addr, add_fee, priv_data).then(function(data) {
                    verify_tx(that, data.tx, key.getAddress().toString(), satoshis, data.change_pointer).then(function() {
                        wallets.sign_and_send_tx($scope, data, false, undefined, false).then(function() {
                            that.encrypted_key = null;
                            var base58Check = {
                              encode: function(buf) {
                                var checkedBuf = [].concat(buf);
                                var buf_words = Bitcoin.convert.bytesToWordArray(buf);
                                var hash = Bitcoin.CryptoJS.SHA256(Bitcoin.CryptoJS.SHA256(buf_words));
                                hash = Bitcoin.convert.wordArrayToBytes(hash);
                                checkedBuf = checkedBuf.concat(hash.slice(0, 4));
                                return Bitcoin.base58.encode(checkedBuf);
                              }
                            };
                            var data = key.priv.toBytes();
                            if ($scope.wallet.send_unencrypted || !that.passphrase) {
                                if (cur_net == 'testnet') {
                                    var version = 0xef;
                                } else {
                                    var version = 0x80;
                                }
                                data.unshift(version);
                                do_send(that, base58Check.encode(data), satoshis);
                            } else {
                                var is_chrome_app = window.chrome && chrome.storage;
                                if (window.cordova) {
                                    cordovaReady(function() {
                                        cordova.exec(function(b58) {
                                            do_send(that, b58, satoshis, key, pointer);
                                        }, function(fail) {
                                            $rootScope.is_loading -= 1;
                                            notices.makeNotice('error', fail);
                                        }, "BIP38", "encrypt", [data, that.passphrase,
                                                'BTC']);  // probably not correct for testnet, but simpler, and compatible with our JS impl
                                    })();
                                } else if (is_chrome_app) {
                                    var process = function() {
                                        var listener = function(message) {
                                            window.removeEventListener('message', listener);
                                            do_send(that, message.data, satoshis, key, pointer);
                                        };
                                        window.addEventListener('message', listener);
                                        iframe.contentWindow.postMessage({eckey: key.priv.toBytes(), password: that.passphrase}, '*');
                                    };
                                    if (!iframe) {
                                        if (document.getElementById("id_iframe_send_bip38")) {
                                            iframe = document.getElementById("id_iframe_send_bip38");
                                            process();
                                        } else {
                                            iframe = document.createElement("IFRAME"); 
                                            iframe.onload = process;
                                            iframe.setAttribute("src", "/bip38_sandbox.html");
                                            iframe.setAttribute("class", "ng-hide");
                                            iframe.setAttribute("id", "id_iframe_send_bip38");
                                            document.body.appendChild(iframe); 
                                        }
                                    } else {
                                        process();
                                    }
                                } else {
                                    var worker = new Worker("/static/js/bip38_worker.min.js");
                                    worker.onmessage = function(message) {
                                        do_send(that, message.data, satoshis, key, pointer);
                                    }
                                    worker.postMessage({eckey: key.priv.toBytes(), password: that.passphrase});
                                }
                            }
                        }, function(error) { 
                            $rootScope.is_loading -= 1;
                        }).finally(function() { that.sending = false; });
                    }, function(error) {
                        $rootScope.is_loading -= 1;
                        that.sending = false;
                        sound.play(BASE_URL + "/static/sound/wentwrong.mp3", $scope);
                        notices.makeNotice('error', gettext('Transaction verification failed: ' + error + '. Please contact support.'))
                    })
                }, function(error) {
                    $rootScope.is_loading -= 1;
                    that.sending = false;
                    notices.makeNotice('error', error.desc);
                });
            };
            tx_sender.call("http://greenaddressit.com/vault/get_next_private_derived_pointer").then(function(pointer) {
                $q.when($scope.wallet.hdwallet.derivePrivate(branches.EXTERNAL)).then(function(key) {
                    $q.when(key.derivePrivate(pointer)).then(function(key) {
                        send(key, pointer);
                    });
                })
            }, function(error) {
                $rootScope.is_loading -= 1;
                that.sending = false;
                notices.makeNotice('error', error.desc);
            });
        },
        send_address: function() {
            var to_addr = this.recipient.constructor === String ? this.recipient : this.recipient.address;
            var parsed_uri = parse_bitcoin_uri(to_addr);
            if (parsed_uri.recipient) to_addr = parsed_uri.recipient;
            var that = this;
            var satoshis = that.amount_to_satoshis(that.amount);
            $rootScope.is_loading += 1;
            var priv_data = {instant: that.instant};
            tx_sender.call("http://greenaddressit.com/vault/prepare_tx", satoshis, to_addr, this.add_fee, priv_data).then(function(data) {
                return verify_tx(that, data.tx, to_addr, satoshis, data.change_pointer).then(function() {
                    return wallets.sign_and_send_tx($scope, data).then(function() {
                        $location.url('/transactions/');
                    });
                }, function(error) {
                    sound.play(BASE_URL + "/static/sound/wentwrong.mp3", $scope);
                    notices.makeNotice('error', gettext('Transaction verification failed: ' + error + '. Please contact support.'))
                });
            }, function(error) {
                notices.makeNotice('error', error.desc);
            }).finally(function() { $rootScope.is_loading -= 1; that.sending = false; });;
        },
        send_to_reddit: function() {
            var that = this;
            tx_sender.call("http://greenaddressit.com/addressbook/reddit_user_has_wallet", this.recipient.address.replace('reddit:', '')).then(function(has_wallet) {
                that.recipient.address = that.recipient.address.replace('reddit:', '');
                if (has_wallet) {
                    var satoshis = that.amount_to_satoshis(that.amount);
                    that._send_social_ga(satoshis);
                } else {
                    that._send_social(that.do_send_reddit);
                }
            }, function(error) {
                that.sending = false;
                notices.makeNotice('error', error.desc);
            });
        },
        send_social: function(do_send) {
            var that = this;
            var name = this.recipient.address;
            if (this.recipient.type == 'reddit') {
                name = name.replace('reddit:', '');
            }
            tx_sender.call("http://greenaddressit.com/addressbook/user_has_wallet", this.recipient.type, name).then(function(has_wallet) {
                that.recipient.address = name;
                if (has_wallet) {
                    var satoshis = that.amount_to_satoshis(that.amount);
                    that._send_social_ga(satoshis);
                } else {
                    that._send_social(do_send);
                }
            }, function(error) {
                that.sending = false;
                notices.makeNotice('error', error.desc);
            });
        },
        send_to_payreq: function() {
            var that = this;
            var satoshis = that.amount_to_satoshis(that.amount);
            that.sending = true;
            tx_sender.call("http://greenaddressit.com/vault/prepare_payreq", satoshis, that.recipient.data).then(function(data) {
                return wallets.sign_and_send_tx($scope, data).then(function() {
                    $location.url('/transactions/');
                });
            }, function(error) {
                notices.makeNotice('error', error.desc);
            }).finally(function() { that.sending = false; });
        },
        send_money: function() {
            if (isNaN(parseFloat(this.amount))) {
                notices.makeNotice('error', gettext('Invalid amount'));
                return;
            }
            if (!this.recipient) {
                notices.makeNotice('error', gettext('Please provide a recipient'));
                return;   
            }
            this.sending = true;
            if (this.recipient.type == 'facebook') {
                gaEvent('Wallet', 'SendToFacebook');
                this.send_social(this.do_send_fb);
            } else if (this.recipient.type == 'email') {
                gaEvent('Wallet', 'SendToEmail');
                this.send_social(this.do_send_email);
            } else if (this.recipient.type == 'address') {
                gaEvent('Wallet', 'SendToAddress');
                this.send_address();
            } else if (this.recipient.type == 'reddit') {
                gaEvent('Wallet', 'SendToReddit');
                this.send_social(this.do_send_reddit);
            } else if (this.recipient.type == 'payreq') {
                gaEvent('Wallet', 'SendToPaymentRequestSent');
                this.send_to_payreq();
            } else if (this.recipient.constructor === String) {
                if (this.recipient.indexOf('@') != -1) {
                    gaEvent('Wallet', 'SendToNewEmail');
                    this.recipient = {type: 'email', name: this.recipient, address: this.recipient};
                    this.send_social(this.do_send_email);
                } else if (this.recipient.indexOf('reddit:') == 0) {
                    gaEvent('Wallet', 'SendToNewReddit');
                    this.recipient = {type: 'reddit', name: this.recipient, address: this.recipient};
                    this.send_social(this.do_send_reddit);
                } else {
                    gaEvent('Wallet', 'SendToNewAddress');
                    this.send_address();
                }
            } else {
                alert('Unsupported recipient type');
            }
        },
        recipient_is_btcaddr: function() {
            return !this.recipient ||
                (this.recipient.constructor === String &&
                    this.recipient.indexOf('@') == -1 &&
                    this.recipient.indexOf('reddit') != 0) ||
                this.recipient.type == 'address' ||
                this.recipient.type == 'payreq' || 
                this.recipient.has_wallet;
        },
        send_to_priv_done: function() {
            this.encrypted_key = undefined;
        }
    };
    var btcToUnit = function(btc) {
        var amount_satoshi = Bitcoin.Util.parseValue(btc);
        return Bitcoin.Util.formatValue(amount_satoshi.multiply(Bitcoin.BigInteger.valueOf(mul)));
    }
    $scope.$watch('send_tx.recipient', function(newValue, oldValue) {
        if (newValue === oldValue) return;
        var parsed_uri = parse_bitcoin_uri(newValue);
        if (parsed_uri.amount) {    
            $scope.send_tx.amount = btcToUnit(parsed_uri.amount);
        }
    });
    $scope.$watch('send_tx.amount', function(newValue, oldValue) {
        if (newValue !== oldValue) {
            var parsed_uri = parse_bitcoin_uri($scope.send_tx.recipient);
            if (parsed_uri.amount && newValue != btcToUnit(parsed_uri.amount)) {
                // replace the URI with recipient when amount is changed
                $scope.send_tx.recipient = parsed_uri.recipient;
            }
        }
    });
    if ($scope.send_tx.recipient && $scope.send_tx.recipient.amount) {
        $scope.send_tx.amount = Bitcoin.Util.formatValue(
            new Bitcoin.BigInteger($scope.send_tx.recipient.amount.toString()).multiply(Bitcoin.BigInteger.valueOf(mul)));
    }


    $scope.processWalletVars().then(function() {
        $scope.clearWalletInitVars();
        var recipient_override;
        if ($scope.wallet.send_to_receiving_id) {
            gaEvent('Wallet', 'SendToReceivingId');
            var receiving_id = $scope.wallet.send_to_receiving_id;
            $scope.wallet.send_to_receiving_id = undefined;
            recipient_override = {name: receiving_id, address: receiving_id, type: receiving_id.indexOf('reddit:') == -1 ? 'address' : 'reddit',
                                  amount: $scope.wallet.send_to_receiving_id_amount};
        } else if ($scope.wallet.send_to_payment_request) {
            gaEvent('Wallet', 'SendToPaymentRequestOpened');
            var data = $scope.wallet.send_to_payment_request;
            $scope.wallet.send_to_payment_request = undefined;
            var name = data.merchant_cn || data.request_url;
            recipient_override = {name: name, data: data, type: 'payreq',
                                  amount: $scope.wallet.send_to_receiving_id_amount,
                                  requires_instant: data.requires_instant};
        }
        if (recipient_override) {
            $scope.send_tx.recipient = recipient_override;
            $scope.send_tx.instant = recipient_override.requires_instant;
            if ($scope.send_tx.recipient && $scope.send_tx.recipient.amount) {
                $scope.send_tx.amount = Bitcoin.Util.formatValue(
                    new Bitcoin.BigInteger($scope.send_tx.recipient.amount.toString()).multiply(Bitcoin.BigInteger.valueOf(mul)));
            }
        }
    });

    wallets.addCurrencyConversion($scope, 'send_tx');
}]);
