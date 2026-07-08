import { useState } from "react";
import iconUrl from "../assets/dshh-icon.png";

type Tab = "ssh" | "sftp" | "serial";

export default function AppMockup({ isMobile }: { isMobile: boolean }) {
  const [tab, setTab] = useState<Tab>("ssh");

  return (
    <div className="mock-wrap">
      <div className="mock">
        <div className="mock-tbar">
          <div className="mock-tbar-l">
            <img className="mock-icon" src={iconUrl} alt="Dshh" />
            <span className="mock-tbar-name">Dshh</span>
          </div>
          <div className="mock-tbar-r">
            <span className="wg">–</span>
            <span className="wg wg-max">▢</span>
            <span className="wg">✕</span>
          </div>
        </div>
        <div className="mock-body">
          {!isMobile && (
            <div className="side">
              <div className="side-top">
                <div className="side-brand">
                  <span className="side-chip">&gt;_</span>
                  <span className="side-brand-name">dshh</span>
                </div>
                <span className="side-plus">+</span>
              </div>
              <div className="side-scroll">
                <div className="side-h">
                  <span className="side-caret">▾</span>
                  <span>production</span>
                  <span className="side-count">3</span>
                </div>
                <div
                  className={
                    "side-row side-row-click row-hv-a" +
                    (tab === "ssh" ? " is-active" : "")
                  }
                  onClick={() => setTab("ssh")}
                >
                  <div className="side-ico ico-ssh">&gt;_</div>
                  <div className="side-meta">
                    <div className="side-host">prod-web-01</div>
                    <div className="side-addr">admin@10.0.4.21:22</div>
                  </div>
                </div>
                <div
                  className="side-row side-row-click row-hv-b"
                  onClick={() => setTab("ssh")}
                >
                  <div className="side-ico ico-ssh">&gt;_</div>
                  <div className="side-meta">
                    <div className="side-host">prod-web-02</div>
                    <div className="side-addr">admin@10.0.4.22:22</div>
                  </div>
                </div>
                <div
                  className={
                    "side-row side-row-click row-hv-a" +
                    (tab === "sftp" ? " is-active" : "")
                  }
                  onClick={() => setTab("sftp")}
                >
                  <div className="side-ico ico-sftp">~/</div>
                  <div className="side-meta">
                    <div className="side-host">assets-bucket</div>
                    <div className="side-addr">deploy@10.0.4.30:22</div>
                  </div>
                </div>
                <div className="side-h side-h-lab">
                  <span className="side-caret">▾</span>
                  <span>lab</span>
                  <span className="side-count">2</span>
                </div>
                <div className="side-row">
                  <div className="side-ico ico-ftp">⇅</div>
                  <div className="side-meta">
                    <div className="side-host">legacy-nas</div>
                    <div className="side-addr">anonymous@192.168.1.40:21</div>
                  </div>
                </div>
                <div
                  className={
                    "side-row side-row-click row-hv-a" +
                    (tab === "serial" ? " is-active" : "")
                  }
                  onClick={() => setTab("serial")}
                >
                  <div className="side-ico ico-serial">⌁</div>
                  <div className="side-meta">
                    <div className="side-host">bench-rig</div>
                    <div className="side-addr">COM4 · 115200 baud</div>
                  </div>
                </div>
              </div>
              <div className="side-foot">
                <span className="side-foot-txt">in-process · no ssh.exe</span>
                <span className="side-gear">⚙</span>
              </div>
            </div>
          )}
          <div className="mock-main">
            <div className="tabs">
              <div
                className={"tab" + (tab === "ssh" ? " is-active" : "")}
                onClick={() => setTab("ssh")}
              >
                {tab === "ssh" && <div className="tab-ind" />}
                <span className="tab-dot dot-green" />
                <span className="tab-proto tp-ssh">SSH</span>
                <span>prod-web-01</span>
              </div>
              <div
                className={"tab" + (tab === "sftp" ? " is-active" : "")}
                onClick={() => setTab("sftp")}
              >
                {tab === "sftp" && <div className="tab-ind" />}
                <span className="tab-dot dot-green" />
                <span className="tab-proto tp-sftp">SFTP</span>
                <span>assets-bucket</span>
              </div>
              <div
                className={"tab" + (tab === "serial" ? " is-active" : "")}
                onClick={() => setTab("serial")}
              >
                {tab === "serial" && <div className="tab-ind" />}
                <span className="tab-dot dot-amber" />
                <span className="tab-proto tp-serial">SERIAL</span>
                <span>bench-rig</span>
              </div>
            </div>
            <div className="pane">
              {tab === "ssh" && (
                <div className="term">
                  <div className="t-dim">· connecting to prod-web-01 …</div>
                  <div className="t-mut">
                    Welcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0-45-generic
                    x86_64)
                  </div>
                  <div className="t-dim">
                    Last login: Tue Jul 7 08:41:07 2026 from 10.0.4.18
                  </div>
                  <div className="t-gap">
                    <span className="t-grn">admin@prod-web-01</span>
                    <span className="t-dim">:</span>
                    <span className="t-acc">~</span>
                    <span className="t-mut">$ uptime</span>
                  </div>
                  <div className="t-mut">
                    09:14:22 up 84 days, 3:12, 1 user, load average: 0.18,
                    0.11, 0.09
                  </div>
                  <div className="t-gap">
                    <span className="t-grn">admin@prod-web-01</span>
                    <span className="t-dim">:</span>
                    <span className="t-acc">~</span>
                    <span className="t-mut">$ docker ps</span>
                  </div>
                  <div className="t-dim">CONTAINER ID IMAGE STATUS NAMES</div>
                  <div className="t-mut">
                    f3a91c02be71 nginx:1.27 Up 12 days edge
                  </div>
                  <div className="t-mut">
                    08c4d1a99e02 api:2026.06 Up 12 days api
                  </div>
                  <div className="t-mut">
                    b1e0c77f4d55 postgres:16 Up 12 days db
                  </div>
                  <div className="t-gap">
                    <span className="t-grn">admin@prod-web-01</span>
                    <span className="t-dim">:</span>
                    <span className="t-acc">~</span>
                    <span className="t-mut">{"$ "}</span>
                    <span className="cursor" />
                  </div>
                </div>
              )}
              {tab === "sftp" && (
                <div className="sftp">
                  <div className="sftp-path">
                    <span className="sftp-tilde">~/</span>
                    <span className="sftp-cwd">/var/www/assets</span>
                    <span className="mini-chip sftp-up">↑ upload</span>
                    <span className="mini-chip mini-chip-sq">⟳</span>
                  </div>
                  <div className="sftp-grid sftp-head">
                    <span>name</span>
                    <span className="sftp-col-r">size</span>
                    <span>modified</span>
                  </div>
                  <div className="sftp-rows">
                    <div className="sftp-grid sftp-row">
                      <span className="f-dir">releases/</span>
                      <span className="f-size-dim">—</span>
                      <span className="f-date">jul 07 09:02</span>
                    </div>
                    <div className="sftp-grid sftp-row">
                      <span className="f-dir">img/</span>
                      <span className="f-size-dim">—</span>
                      <span className="f-date">jun 30 17:44</span>
                    </div>
                    <div className="sftp-grid sftp-row">
                      <span className="f-dir">fonts/</span>
                      <span className="f-size-dim">—</span>
                      <span className="f-date">jun 30 17:44</span>
                    </div>
                    <div className="sftp-grid sftp-row">
                      <span className="f-file">app-2026.06.3.js</span>
                      <span className="f-size">412 KB</span>
                      <span className="f-date">jul 07 08:58</span>
                    </div>
                    <div className="sftp-grid sftp-row">
                      <span className="f-file">styles.css</span>
                      <span className="f-size">88 KB</span>
                      <span className="f-date">jul 07 08:58</span>
                    </div>
                    <div className="sftp-grid sftp-row">
                      <span className="f-file">manifest.json</span>
                      <span className="f-size">2.1 KB</span>
                      <span className="f-date">jun 30 17:41</span>
                    </div>
                  </div>
                  <div className="sftp-status">
                    6 items · sftp · connected as deploy
                  </div>
                </div>
              )}
              {tab === "serial" && (
                <div className="term">
                  <div className="t-dim">· opened COM4 @ 115200 8N1</div>
                  <div>
                    <span className="t-pur">[ 0.000]</span>
                    <span className="t-mut">
                      {" "}
                      boot: ESP32-S3 rev2, flash 8MB
                    </span>
                  </div>
                  <div>
                    <span className="t-pur">[ 0.412]</span>
                    <span className="t-mut">
                      {" "}
                      wifi: sta connected, rssi -58
                    </span>
                  </div>
                  <div>
                    <span className="t-pur">[ 2.103]</span>
                    <span className="t-mut"> sensor: temp=24.6C hum=41%</span>
                  </div>
                  <div>
                    <span className="t-pur">[ 2.104]</span>
                    <span className="t-mut"> mqtt: publish ok → lab/bench</span>
                  </div>
                  <div>
                    <span className="t-pur">[12.103]</span>
                    <span className="t-mut"> sensor: temp=24.7C hum=41%</span>
                  </div>
                  <div>
                    <span className="t-pur">[12.105]</span>
                    <span className="t-mut"> mqtt: publish ok → lab/bench</span>
                  </div>
                  <div className="t-gap">
                    <span className="t-dim">{"> "}</span>
                    <span className="cursor cursor-pur" />
                  </div>
                </div>
              )}
            </div>
            <div className="dock">
              <div className="dock-chips">
                <span className="chip">df -h</span>
                <span className="chip">docker ps</span>
                <span className="chip">tail -f syslog</span>
                <span className="chip-ghost">+ manage</span>
              </div>
              <div className="compose">
                <div className="compose-in">
                  <span className="t-dim">$</span>
                  <span className="t-dim">run a command…</span>
                  <span className="compose-hint">ctrl+k</span>
                </div>
                <span className="bcast">broadcast off</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
