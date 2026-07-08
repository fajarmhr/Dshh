export default function Protocols() {
  return (
    <section id="dsh-features" className="section">
      <div className="wrap sec-in">
        <div className="eyebrow">protocols</div>
        <h2 className="h2">Four protocols. Zero child processes.</h2>
        <div className="grid-proto">
          <div className="pcard pcard-ssh">
            <div className="pcard-ico pi-ssh">&gt;_</div>
            <div className="pcard-head">
              <span className="pcard-name">SSH</span>
              <span className="pcard-crate">russh</span>
            </div>
            <p className="pcard-p">
              Real xterm terminal with buffer search, session logging,
              highlight rules and port forwarding.
            </p>
          </div>
          <div className="pcard pcard-sftp">
            <div className="pcard-ico pi-sftp">~/</div>
            <div className="pcard-head">
              <span className="pcard-name">SFTP</span>
              <span className="pcard-crate">russh-sftp</span>
            </div>
            <p className="pcard-p">
              File browser over your existing SSH hosts — one click from any
              terminal session.
            </p>
          </div>
          <div className="pcard pcard-ftp">
            <div className="pcard-ico pi-ftp">⇅</div>
            <div className="pcard-head">
              <span className="pcard-name">FTP</span>
              <span className="pcard-crate">suppaftp</span>
            </div>
            <p className="pcard-p">
              Plain FTP for the legacy boxes you can't decommission yet.
            </p>
          </div>
          <div className="pcard pcard-serial">
            <div className="pcard-ico pi-serial">⌁</div>
            <div className="pcard-head">
              <span className="pcard-name">Serial</span>
              <span className="pcard-crate">serialport</span>
            </div>
            <p className="pcard-p">
              COM ports at any baud rate — bench rigs, switches, embedded
              consoles.
            </p>
          </div>
        </div>

        <div className="why-grid">
          <div>
            <div className="eyebrow">why in-process</div>
            <h2 className="h2">One exe. The whole client.</h2>
            <div className="checks">
              <div className="check">
                <span className="check-tick">✓</span>
                <span>
                  <span className="check-lead">Single process.</span> Every
                  protocol is a Rust crate compiled into dshh.exe. Nothing
                  spawned, nothing on PATH.
                </span>
              </div>
              <div className="check">
                <span className="check-tick">✓</span>
                <span>
                  <span className="check-lead">Saved profiles.</span> Grouped
                  connections with duplicate and quick reconnect — not a
                  PowerShell history.
                </span>
              </div>
              <div className="check">
                <span className="check-tick">✓</span>
                <span>
                  <span className="check-lead">Tabs + split pane.</span>{" "}
                  Terminals stay mounted across tab switches; buffers survive.
                </span>
              </div>
              <div className="check">
                <span className="check-tick">✓</span>
                <span>
                  <span className="check-lead">Compose + broadcast.</span>{" "}
                  Quick command chips, a Ctrl+K compose bar, and one-keystroke
                  broadcast to every connected host.
                </span>
              </div>
            </div>
          </div>
          <div className="tm">
            <div className="tm-head">task manager — before / after</div>
            <div className="tm-body">
              <div className="tm-c"># the usual stack</div>
              <div className="tm-x">
                putty.exe&nbsp;&nbsp;&nbsp;&nbsp;pageant.exe&nbsp;&nbsp;&nbsp;plink.exe
              </div>
              <div className="tm-x">
                psftp.exe&nbsp;&nbsp;&nbsp;&nbsp;ftp.exe&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ssh.exe
              </div>
              <div className="tm-c tm-sep"># dshh</div>
              <div className="tm-ok">
                dshh.exe
                <span className="tm-ok-note">
                  &nbsp;&nbsp;← ssh · sftp · ftp · serial
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
