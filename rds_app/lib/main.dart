import 'package:flutter/material.dart';
import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

void main() {
  runApp(const RDSApp());
}

class RDSApp extends StatelessWidget {
  const RDSApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RDS Stage 50 Enterprise Core',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF070A10),
        primaryColor: const Color(0xFF00FF88),
      ),
      home: const AdminDashboardScreen(),
    );
  }
}

class AdminDashboardScreen extends StatefulWidget {
  const AdminDashboardScreen({super.key});

  @override
  _AdminDashboardScreenState createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  final String apiBase = "https://rds-lab.onrender.com";

  Map<String, dynamic> stats = {
    'stage': 'STAGE_50_ENTERPRISE_GOVERNANCE',
    'grossVolume': 0,
    'activeDrivers': 0,
    'orders': 0,
    'businesses': 0,
    'totalCommission': 0,
    'totalKraTaxRetained': 0,
    'clusterHealth': 'OPTIMAL',
    'nodeMatrixVersion': 'Universal (Node 18-24+)',
  };

  List<dynamic> drivers = [];
  List<dynamic> orders = [];
  List<dynamic> ledger = [];
  List<dynamic> auditLogs = [];

  bool isLoading = true;
  bool isStkLoading = false;
  bool isConnected = false;

  final TextEditingController _phoneController = TextEditingController(text: "254");
  final TextEditingController _amountController = TextEditingController();
  String _stkStatusMessage = "";
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    fetchDashboardData();
    _refreshTimer = Timer.periodic(const Duration(seconds: 4), (_) => fetchDashboardData());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _phoneController.dispose();
    _amountController.dispose();
    super.dispose();
  }

  Future<void> fetchDashboardData() async {
    try {
      final statsRes = await http.get(Uri.parse('$apiBase/system/stats')).timeout(const Duration(seconds: 4));
      final driversRes = await http.get(Uri.parse('$apiBase/drivers')).timeout(const Duration(seconds: 4));
      final ordersRes = await http.get(Uri.parse('$apiBase/orders')).timeout(const Duration(seconds: 4));
      final ledgerRes = await http.get(Uri.parse('$apiBase/ledger')).timeout(const Duration(seconds: 4));

      if (mounted) {
        setState(() {
          if (statsRes.statusCode == 200) {
            final data = json.decode(statsRes.body);
            stats = data['stats'] ?? stats;
            isConnected = true;
          }
          if (driversRes.statusCode == 200) drivers = json.decode(driversRes.body)['drivers'] ?? [];
          if (ordersRes.statusCode == 200) orders = json.decode(ordersRes.body)['orders'] ?? [];
          if (ledgerRes.statusCode == 200) ledger = json.decode(ledgerRes.body)['ledger'] ?? [];
          isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => isLoading = false);
    }
  }

  Future<void> triggerStkPush() async {
    final phone = _phoneController.text.trim();
    final amount = _amountController.text.trim();

    if (phone.isEmpty || amount.isEmpty) {
      setState(() => _stkStatusMessage = "⚠️ Phone number and amount required.");
      return;
    }

    setState(() {
      isStkLoading = true;
      _stkStatusMessage = "Initiating Stage 50 STK Gateway...";
    });

    try {
      final response = await http.post(
        Uri.parse('$apiBase/payments/stk-push'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'phone': phone, 'amount': amount}),
      ).timeout(const Duration(seconds: 10));

      final data = json.decode(response.body);
      if (response.statusCode == 200 || response.statusCode == 201) {
        setState(() => _stkStatusMessage = "✅ STK Dispatched! ID: ${data['CheckoutRequestID'] ?? 'OK'}");
        fetchDashboardData();
      } else {
        setState(() => _stkStatusMessage = "❌ Error: ${data['message'] ?? 'Gateway rejected'}");
      }
    } catch (e) {
      setState(() => _stkStatusMessage = "❌ Network Error: Node endpoint unreachable.");
    } finally {
      if (mounted) setState(() => isStkLoading = false);
    }
  }

  Future<void> triggerRefund(String orderId) async {
    try {
      final response = await http.post(
        Uri.parse('$apiBase/order/refund'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'orderId': orderId, 'reason': 'Stage 50 Executive Override'}),
      );
      if (response.statusCode == 200) {
        fetchDashboardData();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Stage 50 Escrow Refund Executed: Order #$orderId')),
        );
      }
    } catch (e) {
      print('[STAGE 50 REFUND ERROR] $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF070A10),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0F172A),
        title: Row(
          children: const [
            Icon(Icons.shield_outlined, color: Color(0xFF00FF88)),
            SizedBox(width: 8),
            Text(
              'RDS STAGE 50 — ENTERPRISE COMMAND CENTER',
              style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.bold, letterSpacing: 0.8),
            ),
          ],
        ),
        actions: [
          Center(
            child: Padding(
              padding: const EdgeInsets.only(right: 12.0),
              child: Chip(
                avatar: Icon(Icons.circle, color: isConnected ? const Color(0xFF00FF88) : Colors.amber, size: 9),
                label: Text(
                  stats['stage']?.toString() ?? 'STAGE_50_ENTERPRISE',
                  style: const TextStyle(fontSize: 9, color: Colors.white, fontWeight: FontWeight.bold),
                ),
                backgroundColor: const Color(0xFF1E293B),
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.sync, color: Color(0xFF00FF88)),
            onPressed: () {
              setState(() => isLoading = true);
              fetchDashboardData();
            },
          )
        ],
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF00FF88)))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(12.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GridView.count(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    crossAxisCount: MediaQuery.of(context).size.width > 1000 ? 4 : 2,
                    crossAxisSpacing: 8,
                    mainAxisSpacing: 8,
                    childAspectRatio: 2.3,
                    children: [
                      _buildStatCard("GROSS PLATFORM VOLUME", "KES ${stats['grossVolume'] ?? 0}"),
                      _buildStatCard("ACTIVE FLEET DRIVERS", "${stats['activeDrivers'] ?? 0}"),
                      _buildStatCard("PLATFORM NET REVENUE", "KES ${stats['totalCommission'] ?? 0}"),
                      _buildStatCard("KRA COMPLIANCE VAULT", "KES ${stats['totalKraTaxRetained'] ?? 0}", const Color(0xFFFF9900)),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _buildStkPushForm(),
                  const SizedBox(height: 12),
                  SizedBox(
                    height: 440,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: _buildPanel("1. FLEET TELEMETRY & DRIVERS", _buildDriversList())),
                        const SizedBox(width: 8),
                        Expanded(child: _buildPanel("2. ESCROW DISPATCH & ORDERS", _buildOrdersList())),
                        const SizedBox(width: 8),
                        Expanded(child: _buildPanel("3. AUDITED DOUBLE-ENTRY LEDGER", _buildLedgerList())),
                        const SizedBox(width: 8),
                        Expanded(child: _buildPanel("4. NODE MATRIX & GOVERNANCE", _buildEngineHealth())),
                      ],
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _buildStatCard(String title, String value, [Color valueColor = const Color(0xFFFFD700)]) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        border: Border.all(color: const Color(0xFF1E293B)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(title, style: const TextStyle(color: Colors.grey, fontSize: 9, letterSpacing: 1.0)),
          const SizedBox(height: 4),
          Text(value, style: TextStyle(color: valueColor, fontSize: 16, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }

  Widget _buildStkPushForm() {
    return Container(
      padding: const EdgeInsets.all(12.0),
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        border: Border.all(color: const Color(0xFF00FF88), width: 1),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.flash_on, color: Color(0xFF00FF88), size: 18),
              SizedBox(width: 8),
              Text("STAGE 50 HIGH-SPEED STK GATEWAY", style: TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                  decoration: const InputDecoration(
                    labelText: "Recipient Phone (2547XXXXXXXX)",
                    labelStyle: TextStyle(color: Colors.grey, fontSize: 10),
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.grey)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Color(0xFF00FF88))),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _amountController,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                  decoration: const InputDecoration(
                    labelText: "Settlement Amount (KES)",
                    labelStyle: TextStyle(color: Colors.grey, fontSize: 10),
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.grey)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Color(0xFF00FF88))),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 38,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00FF88),
                    foregroundColor: Colors.black,
                  ),
                  onPressed: isStkLoading ? null : triggerStkPush,
                  child: isStkLoading
                      ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(color: Colors.black, strokeWidth: 2))
                      : const Text("EXECUTE STK", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 10)),
                ),
              ),
            ],
          ),
          if (_stkStatusMessage.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              _stkStatusMessage,
              style: TextStyle(
                color: _stkStatusMessage.startsWith("✅") ? const Color(0xFF00FF88) : Colors.amber,
                fontSize: 10,
              ),
            ),
          ]
        ],
      ),
    );
  }

  Widget _buildPanel(String title, Widget child) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        border: Border.all(color: const Color(0xFF1E293B)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
            color: const Color(0xFF1E293B),
            width: double.infinity,
            child: Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 10)),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }

  Widget _buildDriversList() {
    return drivers.isEmpty
        ? const Center(child: Text("No Active Drivers", style: TextStyle(color: Colors.grey, fontSize: 10)))
        : ListView.builder(
            itemCount: drivers.length,
            itemBuilder: (context, i) {
              final d = drivers[i];
              return ListTile(
                dense: true,
                leading: const Icon(Icons.two_wheeler, color: Color(0xFF00FF88), size: 15),
                title: Text(d['name'] ?? 'Driver', style: const TextStyle(color: Colors.white, fontSize: 10)),
                subtitle: Text(d['vehicle'] ?? '', style: const TextStyle(color: Colors.grey, fontSize: 8)),
                trailing: Text("KES ${d['earnings'] ?? 0}", style: const TextStyle(color: Colors.greenAccent, fontSize: 9)),
              );
            },
          );
  }

  Widget _buildOrdersList() {
    return orders.isEmpty
        ? const Center(child: Text("No Active Escrow Orders", style: TextStyle(color: Colors.grey, fontSize: 10)))
        : ListView.builder(
            itemCount: orders.length,
            itemBuilder: (context, i) {
              final o = orders[i];
              final isEscrow = o['status'] == 'ESCROW_LOCKED';
              return ListTile(
                dense: true,
                title: Text("Order #${o['id']}", style: const TextStyle(color: Colors.white, fontSize: 10)),
                subtitle: Text("KES ${o['total']}", style: const TextStyle(color: Colors.grey, fontSize: 8)),
                trailing: isEscrow
                    ? IconButton(
                        icon: const Icon(Icons.restore, color: Colors.redAccent, size: 14),
                        onPressed: () => triggerRefund(o['id']),
                      )
                    : Text(o['status'] ?? '', style: const TextStyle(color: Color(0xFF00FF88), fontSize: 8)),
              );
            },
          );
  }

  Widget _buildLedgerList() {
    return ledger.isEmpty
        ? const Center(child: Text("No Ledger Logs", style: TextStyle(color: Colors.grey, fontSize: 10)))
        : ListView.builder(
            itemCount: ledger.length,
            itemBuilder: (context, i) {
              final l = ledger[i];
              return ListTile(
                dense: true,
                leading: const Icon(Icons.receipt_long, color: Colors.indigoAccent, size: 14),
                title: Text(l['type'] ?? 'TX', style: const TextStyle(color: Colors.white, fontSize: 9)),
                trailing: Text("KES ${l['amount'] ?? l['grossTotal'] ?? 0}", style: const TextStyle(color: Colors.white, fontSize: 9)),
              );
            },
          );
  }

  Widget _buildEngineHealth() {
    return Padding(
      padding: const EdgeInsets.all(10.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _healthItem("Node Matrix Runtime", "Universal (Node 18 -> 24+)"),
          _healthItem("Governance Core", "Stage 50 Enterprise"),
          _healthItem("Consensus Engine", "Active Multi-Sig Vault"),
          _healthItem("Escrow Protocol", "Double-Entry Split Engine"),
          _healthItem("Tax Compliance", "Real-time KRA Retention"),
          const Spacer(),
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: const Color(0xFF064E3B),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Row(
              children: const [
                Icon(Icons.verified_user, color: Color(0xFF00FF88), size: 14),
                SizedBox(width: 6),
                Text("STAGE 50 GOVERNANCE ACTIVE", style: TextStyle(color: Colors.white, fontSize: 9, fontWeight: FontWeight.bold)),
              ],
            ),
          )
        ],
      ),
    );
  }

  Widget _healthItem(String label, String val) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: Colors.grey, fontSize: 8)),
          Text(val, style: const TextStyle(color: Colors.white, fontSize: 9, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}